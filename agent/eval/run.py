"""Run the eval against the REAL model. Free-tier aware. Never run in CI.

    uv run python -m eval.run --label baseline --estimate          # what it would cost, no API calls
    uv run python -m eval.run --label baseline                     # all 50 items x 3
    uv run python -m eval.run --label e1 --subset                  # the 20-item subset x 2
    uv run python -m eval.run --label baseline                     # again: resumes where it stopped

Results go to eval/results/<label>.jsonl, one line per (item, repetition). A
second run with the same label skips what is done and retries only upstream
failures. Every model call goes through a throttle (requests per minute), the
run stops cleanly at --max-calls, and when the model API fails (429/503) the
runner waits 30 s, 60 s, 120 s (with jitter) and then records the attempt as
`upstream_failed`: counted on its own, never as a wrong answer. Three upstream
failures in a row stop the run (the quota is probably used up for today).
"""

import argparse
import dataclasses
import json
import random
import sys
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from ledger_agent.config import apply_tracing_env, load_settings
from ledger_agent.db import ClientContext, create_pool
from ledger_agent.llm import UpstreamModelError, build_chat_model, build_embeddings
from ledger_agent.service import Assistant
from ledger_agent.tools import LedgerTools

from .instrument import ChatMeter, Meter, MeteredEmbeddings, Throttle, TimedLedgerTools
from .questions import ITEMS, SUBSET, Item
from .score import score
from .seed import EVAL_NOW, seed
from .truth import Truth

RESULTS_DIR = Path(__file__).resolve().parent / "results"
BACKOFF_S = (30, 60, 120)
STOP_AFTER_CONSECUTIVE_UPSTREAM_FAILURES = 3

# Model calls per question, by category, from the 7b real-model runs (chat, embedding).
# Only for the --estimate; the report counts what was actually used.
ESTIMATED_CALLS: dict[str, tuple[int, int]] = {
    "balance": (4, 0),
    "transaction": (5, 0),
    "topup": (5, 0),
    "period": (5, 0),
    "policy": (2, 1),
    "both": (6, 1),
    "out_of_scope": (1, 0),
    "other_client": (4, 0),
    "injection": (5, 0),
}
EST_INPUT_TOKENS_PER_CHAT_CALL = 1_300


def plan(items: tuple[Item, ...], reps: int) -> Iterator[tuple[Item, int]]:
    for rep in range(1, reps + 1):
        for item in items:
            yield item, rep


def estimate(items: tuple[Item, ...], reps: int) -> tuple[int, int]:
    chat = sum(ESTIMATED_CALLS[i.category][0] for i in items) * reps
    emb = sum(ESTIMATED_CALLS[i.category][1] for i in items) * reps
    return chat, emb


def load_done(path: Path) -> dict[tuple[str, int], dict[str, Any]]:
    done: dict[tuple[str, int], dict[str, Any]] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                done[(r["item"], r["rep"])] = r  # later lines win (a retried upstream failure)
    return done


def backoff_delays(rng: random.Random) -> list[float]:
    """30, 60, 120 s, each with up to +20 % jitter so parallel runners do not retry in lock-step."""
    return [b * (1 + 0.2 * rng.random()) for b in BACKOFF_S]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--label", required=True, help="results file name, e.g. baseline, e1-prefetch")
    p.add_argument(
        "--subset", action="store_true", help="the 20-item subset (default reps 2) instead of all 50 (reps 3)"
    )
    p.add_argument("--reps", type=int, default=None)
    p.add_argument("--only", default="", help="comma-separated item ids")
    p.add_argument("--rpm-chat", type=int, default=10, help="chat-model requests per minute (stay under your quota)")
    p.add_argument("--rpm-embed", type=int, default=10, help="embedding requests per minute")
    p.add_argument(
        "--max-calls", type=int, default=400, help="stop before exceeding this many API calls in this invocation"
    )
    p.add_argument("--estimate", action="store_true", help="print what the run would cost and exit (no API calls)")
    args = p.parse_args(argv)

    items = SUBSET if args.subset else ITEMS
    if args.only:
        wanted = set(args.only.split(","))
        items = tuple(i for i in items if i.id in wanted)
    reps = args.reps or (2 if args.subset else 3)
    path = RESULTS_DIR / f"{args.label}.jsonl"
    done = load_done(path)
    todo = [(i, r) for i, r in plan(items, reps) if done.get((i.id, r), {}).get("status") != "ok"]
    chat_est, emb_est = estimate(tuple(i for i, _ in todo), 1)
    print(
        f"{args.label}: {len(items)} items x {reps} = {len(items) * reps} questions; {len(todo)} still to run.\n"
        f"estimated API calls for those: {chat_est} chat + {emb_est} embedding = {chat_est + emb_est}"
        f" (~{chat_est * EST_INPUT_TOKENS_PER_CHAT_CALL:,} input tokens); budget this invocation: {args.max_calls}"
    )
    if args.estimate or not todo:
        return 0

    apply_tracing_env()
    settings = dataclasses.replace(load_settings(), daily_limit=1_000_000)  # eval clients are not rate-limited
    assert settings.owner_database_url, "OWNER_DATABASE_URL must be set (seeding and truth run as the owner)"
    owner = psycopg.connect(settings.owner_database_url, row_factory=dict_row, autocommit=True)
    print("seeded the eval ledger now" if seed(owner) else "eval ledger already seeded")
    truth = Truth(owner)
    meter = Meter()
    chat = build_chat_model(settings)
    chat.callbacks = [ChatMeter(meter, Throttle(args.rpm_chat))]
    embeddings = MeteredEmbeddings(build_embeddings(settings), meter, Throttle(args.rpm_embed))
    pool = create_pool(settings.database_url, settings.pool_size)
    assistant = Assistant(
        pool, settings, chat, embeddings, now_fn=lambda: EVAL_NOW, ledger=TimedLedgerTools(LedgerTools(pool), meter)
    )
    rng = random.Random()
    RESULTS_DIR.mkdir(exist_ok=True)
    used = 0
    consecutive_upstream = 0
    try:
        with path.open("a") as out:
            for item, rep in todo:
                est_chat, est_emb = ESTIMATED_CALLS[item.category]
                if used + est_chat + est_emb > args.max_calls:
                    print(
                        f"budget: {used} calls used, the next question may need {est_chat + est_emb}; "
                        "stopping. Re-run to resume."
                    )
                    break
                record = run_one(assistant, meter, owner, truth, item, rep, args.label, rng)
                used += record["chat_calls"] + record["embed_calls"]
                out.write(json.dumps(record) + "\n")
                out.flush()
                mark = {"ok": "correct" if record.get("score", {}).get("correct") else "wrong"}.get(
                    record["status"], record["status"]
                )
                print(
                    f"  {item.id:4s} #{rep}  {mark:16s} calls {record['chat_calls']}+{record['embed_calls']}  "
                    f"{record['latency_s']:.1f}s  (used {used})"
                )
                consecutive_upstream = consecutive_upstream + 1 if record["status"] == "upstream_failed" else 0
                if consecutive_upstream >= STOP_AFTER_CONSECUTIVE_UPSTREAM_FAILURES:
                    print(
                        "three upstream failures in a row: the quota is probably used up. "
                        "Stopping; re-run later to resume."
                    )
                    break
    finally:
        pool.close()
        owner.close()
    return 0


def run_one(
    assistant: Assistant,
    meter: Meter,
    owner: psycopg.Connection[Any],
    truth: Truth,
    item: Item,
    rep: int,
    label: str,
    rng: random.Random,
) -> dict[str, Any]:
    """One (item, repetition), with backoff on upstream failures. Returns the JSON record."""
    ctx = ClientContext(client_id=item.client)
    trace = {
        "run_name": f"eval {label} {item.id}#{rep}",
        "tags": ["eval", label, item.category],
        "metadata": {"eval_label": label, "eval_item": item.id, "eval_rep": rep, "eval_category": item.category},
    }
    base: dict[str, Any] = {
        "item": item.id,
        "rep": rep,
        "label": label,
        "category": item.category,
        "started_at": datetime.now(UTC).isoformat(),
    }
    errors: list[str] = []
    chat_total = embed_total = 0
    for attempt, delay in enumerate([*backoff_delays(rng), None], start=1):
        meter.reset()
        started = time.perf_counter()
        try:
            result = assistant.ask(ctx, item.question, trace=trace)  # type: ignore[arg-type]
        except UpstreamModelError as e:
            chat_total += meter.chat_calls
            embed_total += meter.embed_calls
            errors.append(str(e)[:300])
            if delay is None:
                return {
                    **base,
                    "status": "upstream_failed",
                    "attempts": attempt,
                    "errors": errors,
                    "chat_calls": chat_total,
                    "embed_calls": embed_total,
                    "latency_s": 0.0,
                }
            print(f"  {item.id:4s} #{rep}  upstream failure (attempt {attempt}): waiting {delay:.0f}s")
            time.sleep(delay)
            continue
        # End to end, minus the time our own throttle held the question back.
        latency = time.perf_counter() - started - meter.wait_s
        break
    run = owner.execute(
        "SELECT prompt_tokens, completion_tokens, retrieved_chunk_ids, attempts, verify_failures"
        " FROM agent_runs WHERE id = %s",
        (result.run_id,),
    ).fetchone()
    assert run is not None
    expect = item.expect(truth)
    expected_chunks = set().union(*(truth.chunk_ids(f, h) for f, h in expect.chunks)) if expect.chunks else set()
    s = score(item, expect, result.answer, result.verified, set(run["retrieved_chunk_ids"]), expected_chunks)
    model_s, embed_s, tool_s = meter.model_s, meter.embed_s, meter.tool_s
    return {
        **base,
        "status": "ok",
        "attempts": len(errors) + 1,
        "errors": errors,
        "run_id": result.run_id,
        "answer": result.answer,
        "citations": [{"type": c.type, "id": c.id} for c in result.citations],
        "verified": result.verified,
        "answer_attempts": run["attempts"],
        "verify_failures": run["verify_failures"],
        "score": s.as_dict(),
        "chat_calls": chat_total + meter.chat_calls,
        "embed_calls": embed_total + meter.embed_calls,
        "tokens_in": run["prompt_tokens"],
        "tokens_out": run["completion_tokens"],
        "latency_s": latency,
        "wait_s": meter.wait_s,
        "model_s": model_s,
        "embed_s": embed_s,
        "tool_s": tool_s,
        "own_s": max(0.0, latency - model_s - embed_s - tool_s),
    }


if __name__ == "__main__":
    sys.exit(main())
