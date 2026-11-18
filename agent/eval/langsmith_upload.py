"""Put the eval into LangSmith: the items as a dataset, one run as an experiment. ZERO model calls.

    uv run python -m eval.langsmith_upload baseline          # dataset (once) + experiment "baseline"
    uv run python -m eval.langsmith_upload e2-answer-tool    # another experiment, comparable side by side

The experiment's "target" does not call the assistant: it replays the answers
already recorded in eval/results/<label>.jsonl, and our deterministic scores
become LangSmith feedback. So uploading costs nothing against the model quota,
and two experiments on the same dataset can be compared in the LangSmith UI.

Needs LANGSMITH_API_KEY (agent/.env). Without it this script exits with a
message; nothing else in the eval depends on LangSmith. Every LangSmith
deprecation warning is an error here, so a deprecated endpoint is never used.
"""

import os
import sys
import warnings
from collections import defaultdict
from typing import Any

import psycopg
from psycopg.rows import dict_row

from ledger_agent.config import apply_tracing_env, load_settings
from ledger_agent.verify import format_paise

from .questions import ITEMS
from .run import RESULTS_DIR, load_done
from .seed import seed
from .truth import Truth

DATASET = "ledger-agent-eval"
METRICS = ("correct", "verified", "fallback", "numbers_ok", "words_ok", "retrieval_hit", "refused", "forbidden_hit")


def sync_dataset(client: Any, truth: Truth) -> Any:
    """Create the dataset once, and add any item it does not have yet (matched by metadata.item_id)."""
    if client.has_dataset(dataset_name=DATASET):
        dataset = client.read_dataset(dataset_name=DATASET)
    else:
        dataset = client.create_dataset(
            DATASET,
            description="ledger-service assistant eval: 40 questions + 10 prompt-injection cases (fictional data)",
        )
    have = {(e.metadata or {}).get("item_id") for e in client.list_examples(dataset_id=dataset.id)}
    new = []
    for item in ITEMS:
        if item.id in have:
            continue
        e = item.expect(truth)
        new.append(
            {
                "inputs": {"question": item.question, "client": item.client, "item_id": item.id},
                "outputs": {
                    "amounts": sorted(format_paise(a) for a in e.amounts),
                    "words": list(e.words),
                    "chunks": [f"{f} / {h}" for f, h in e.chunks],
                    "refuse": e.refuse,
                    "forbidden_amounts": sorted(format_paise(a) for a in e.forbidden_amounts),
                },
                "metadata": {"item_id": item.id, "category": item.category, "subset": item.subset},
            }
        )
    if new:
        client.create_examples(dataset_id=dataset.id, examples=new)
    print(f"dataset {DATASET}: {len(have - {None}) + len(new)} examples ({len(new)} added now)")
    return dataset


def upload_experiment(client: Any, label: str) -> None:
    records = load_done(RESULTS_DIR / f"{label}.jsonl")
    if not records:
        raise SystemExit(f"no results for {label}")
    reps = max(rep for _, rep in records)
    seen: dict[str, int] = defaultdict(int)

    def replay(inputs: dict[str, Any]) -> dict[str, Any]:
        """The nth call for an item replays repetition n of the recorded run."""
        item_id = inputs["item_id"]
        seen[item_id] += 1
        r = records.get((item_id, seen[item_id]))
        if r is None:
            return {"status": "not_run"}
        if r["status"] != "ok":
            return {"status": r["status"], "errors": r.get("errors", [])}
        return {
            "status": "ok",
            "answer": r["answer"],
            "citations": r["citations"],
            "verified": r["verified"],
            "score": r["score"],
            "chat_calls": r["chat_calls"],
            "embed_calls": r["embed_calls"],
            "tokens_in": r["tokens_in"],
            "latency_s": round(r["latency_s"], 3),
        }

    def scores(outputs: dict[str, Any]) -> dict[str, Any]:
        if outputs.get("status") != "ok":
            return {"results": [{"key": "upstream_failed", "score": int(outputs.get("status") == "upstream_failed")}]}
        s = outputs["score"]
        results = [{"key": k, "score": int(s[k])} for k in METRICS if s.get(k) is not None]
        results += [
            {"key": "model_calls", "score": outputs["chat_calls"] + outputs["embed_calls"]},
            {"key": "latency_s", "score": outputs["latency_s"]},
        ]
        return {"results": results}

    result = client.evaluate(
        replay,
        data=DATASET,
        evaluators=[scores],
        experiment_prefix=label,
        description=f"Replay of eval/results/{label}.jsonl (no model calls)",
        num_repetitions=reps,
        max_concurrency=0,  # sequential: the nth call per item is repetition n
        metadata={"eval_label": label, "repetitions": reps},
    )
    print(f"experiment uploaded: {getattr(result, 'experiment_name', label)}")


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__)
        return 1
    warnings.filterwarnings("error", message=r".*is deprecated and will be removed after", category=DeprecationWarning)
    apply_tracing_env()
    if not os.environ.get("LANGSMITH_API_KEY"):
        print("LANGSMITH_API_KEY is not set (agent/.env): nothing to upload. The eval itself does not need LangSmith.")
        return 0
    from langsmith import Client

    settings = load_settings()
    assert settings.owner_database_url, "OWNER_DATABASE_URL must be set"
    with psycopg.connect(settings.owner_database_url, row_factory=dict_row, autocommit=True) as owner:
        seed(owner)
        client = Client()
        sync_dataset(client, Truth(owner))
        upload_experiment(client, argv[0])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
