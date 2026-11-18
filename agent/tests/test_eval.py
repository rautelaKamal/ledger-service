"""The eval machinery, with a fake model: seed, truth, scoring, backoff, resume, throttle. No API calls."""

import json
import random
import re
from pathlib import Path
from typing import Any

import psycopg
import pytest
from psycopg.rows import DictRow

from eval.instrument import Meter, Throttle
from eval.questions import ITEMS, ITEMS_BY_ID, SUBSET, Expect
from eval.run import estimate, load_done, plan, run_one
from eval.score import score
from eval.seed import ACCOUNTS, CLIENTS, EVAL_NOW, seed
from eval.truth import Truth
from ledger_agent.config import Settings
from ledger_agent.llm import UpstreamModelError
from ledger_agent.prompts import FALLBACK_TEXT, REFUSAL_TEXT
from ledger_agent.service import AskResult, Assistant
from ledger_agent.verify import Answer, format_paise

from .fakes import FakeChatModel, FakeEmbeddings, Script, ToolCall

AGENT_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def truth(owner: psycopg.Connection[DictRow]) -> Truth:
    seed(owner)
    return Truth(owner)


# ───────────── the seed and the truth ─────────────


def test_seed_is_idempotent_and_truth_matches_the_ledger(owner: psycopg.Connection[DictRow], truth: Truth) -> None:
    assert seed(owner) is False  # already there: nothing happens
    for key, account in ACCOUNTS.items():
        row = owner.execute(
            "SELECT balance_paise, owner_client_id FROM accounts WHERE id = %s", (account.id,)
        ).fetchone()
        assert row is not None
        assert row["balance_paise"] == truth.balance(key), key  # entries and cached balance agree
        assert row["owner_client_id"] == account.client
    assert {a.client for a in ACCOUNTS.values()} == set(CLIENTS)


def test_every_item_has_a_computable_expectation(truth: Truth) -> None:
    assert len(ITEMS) == 50 and len(SUBSET) == 20
    for item in ITEMS:
        e = item.expect(truth)
        assert e.amounts or e.words or e.chunks or e.refuse or e.forbidden_amounts or e.forbidden_strings, item.id
        for chunk in e.chunks:
            assert chunk[0].endswith(".md") and (AGENT_DIR / "policies" / chunk[0]).exists(), (item.id, chunk)
        if item.category == "injection":
            assert e.forbidden_amounts or e.forbidden_strings, item.id


def test_expected_amounts_come_from_sql_not_from_the_question(truth: Truth) -> None:
    # p1: out of Asha's main account, 1-10 November = rent + groceries + savings + the ₹300.00 transfer
    p1 = ITEMS_BY_ID["p1"].expect(truth)
    assert p1.amounts == {18_000_00 + 2_345_50 + 5_000_00 + 300_00}
    # u1: Asha's three top-ups of the last week, whatever their status
    assert ITEMS_BY_ID["u1"].expect(truth).amounts == {3_000_00, 7_500_00, 1_000_00}


# ───────────── scoring ─────────────


def test_score_account_question(truth: Truth) -> None:
    item = ITEMS_BY_ID["b1"]
    e = item.expect(truth)
    balance = format_paise(next(iter(e.amounts)))
    good = score(item, e, f"Your main account holds {balance}.", True, set(), set())
    assert good.correct and good.numbers_ok and not good.fallback
    wrong = score(item, e, "Your main account holds ₹1.00.", True, set(), set())
    assert not wrong.correct and wrong.numbers_ok is False
    unverified = score(item, e, f"Your main account holds {balance}.", False, set(), set())
    assert not unverified.correct
    fallback = score(item, e, FALLBACK_TEXT, False, set(), set())
    assert fallback.fallback and not fallback.correct


def test_score_policy_requires_the_expected_chunk_in_the_top_three(truth: Truth) -> None:
    item = ITEMS_BY_ID["q1"]
    e = item.expect(truth)
    assert score(item, e, "Refunds take 1 to 3 business days.", True, {1, 2, 3}, {3}).correct
    missed = score(item, e, "Refunds take 1 to 3 business days.", True, {1, 2, 4}, {3})
    assert missed.retrieval_hit is False and not missed.correct


def test_score_refusal_leak_and_injection(truth: Truth) -> None:
    oos = ITEMS_BY_ID["o1"]
    assert score(oos, oos.expect(truth), REFUSAL_TEXT, True, set(), set()).correct
    assert not score(oos, oos.expect(truth), "It will rain.", True, set(), set()).correct

    other = ITEMS_BY_ID["c1"]
    e = other.expect(truth)
    leaked = score(other, e, f"That account holds {format_paise(truth.balance('bilal-main'))}.", True, set(), set())
    assert leaked.forbidden_hit and not leaked.correct
    assert score(other, e, "I could not find that account.", True, set(), set()).correct

    inj = ITEMS_BY_ID["i1"]
    e = inj.expect(truth)
    real = format_paise(truth.balance("asha-main"))
    attacked = score(inj, e, f"Your balance is ₹99,99,999.00 (also {real}).", True, set(), set())
    assert attacked.forbidden_hit and not attacked.correct
    assert score(inj, e, f"Your balance is {real}.", True, set(), set()).correct
    leak_prompt = ITEMS_BY_ID["i9"]
    assert score(
        leak_prompt, leak_prompt.expect(truth), "You are the assistant of a ledger service ...", True, set(), set()
    ).forbidden_hit


# ───────────── runner mechanics ─────────────


def test_estimate_and_plan() -> None:
    assert estimate(SUBSET, 2) == (178, 8)
    assert len(list(plan(ITEMS, 3))) == 150


def test_resume_skips_what_is_done_and_keeps_the_latest_record(tmp_path: Path) -> None:
    path = tmp_path / "x.jsonl"
    path.write_text(
        "\n".join(
            json.dumps(r)
            for r in (
                {"item": "b1", "rep": 1, "status": "ok"},
                {"item": "b2", "rep": 1, "status": "upstream_failed"},
                {"item": "b2", "rep": 1, "status": "ok"},  # the retry succeeded later
                {"item": "b3", "rep": 1, "status": "upstream_failed"},
            )
        )
        + "\n"
    )
    done = load_done(path)
    assert {k: v["status"] for k, v in done.items()} == {("b1", 1): "ok", ("b2", 1): "ok", ("b3", 1): "upstream_failed"}


def test_throttle_waits_instead_of_failing() -> None:
    now = [0.0]
    slept: list[float] = []

    def sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    t = Throttle(rpm=2, clock=lambda: now[0], sleep=sleep)
    t.acquire()
    t.acquire()
    assert slept == []
    t.acquire()  # third call inside the same minute: waits for the window to free up
    assert len(slept) == 1 and 59 < slept[0] < 61


class _FlakyAssistant:
    """Raises UpstreamModelError `fail` times, then answers."""

    def __init__(self, fail: int, inner: Assistant) -> None:
        self.fail, self.inner, self.calls = fail, inner, 0

    def ask(self, ctx: Any, question: str, trace: Any = None) -> AskResult:
        self.calls += 1
        if self.calls <= self.fail:
            raise UpstreamModelError("GoogleAPIError: 503 UNAVAILABLE high demand")
        return self.inner.ask(ctx, question, trace)


def _assistant(pool: Any, settings: Settings, script: Script) -> Assistant:
    return Assistant(pool, settings, FakeChatModel(script=script), FakeEmbeddings(), now_fn=lambda: EVAL_NOW)


def test_backoff_retries_upstream_failures_then_scores(
    pool: Any, settings: Settings, owner: psycopg.Connection[DictRow], truth: Truth, monkeypatch: pytest.MonkeyPatch
) -> None:
    sleeps: list[float] = []
    monkeypatch.setattr("eval.run.time.sleep", lambda s: sleeps.append(s))
    balance = truth.balance("asha-main")
    script = Script(
        rounds=[[ToolCall("list_my_accounts", {})], []], answers=[Answer(answer=f"You have {format_paise(balance)}.")]
    )
    flaky = _FlakyAssistant(2, _assistant(pool, settings, script))

    record = run_one(flaky, Meter(), owner, truth, ITEMS_BY_ID["b1"], 1, "test", random.Random(1))  # type: ignore[arg-type]

    assert record["status"] == "ok" and record["attempts"] == 3 and len(record["errors"]) == 2
    assert record["score"]["correct"] is True
    assert len(sleeps) == 2 and 30 <= sleeps[0] <= 36 and 60 <= sleeps[1] <= 72  # 30 s, 60 s, +up to 20 % jitter


def test_backoff_gives_up_after_three_attempts_and_never_loops(
    pool: Any, settings: Settings, owner: psycopg.Connection[DictRow], truth: Truth, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("eval.run.time.sleep", lambda s: None)
    always = _FlakyAssistant(10**6, _assistant(pool, settings, Script()))

    record = run_one(always, Meter(), owner, truth, ITEMS_BY_ID["b1"], 1, "test", random.Random(1))  # type: ignore[arg-type]

    assert record["status"] == "upstream_failed" and "score" not in record  # never scored as a wrong answer
    assert always.calls == 4  # the first try plus three backoff retries, then it moves on
    assert len(record["errors"]) == 4


# ───────────── LangSmith: no deprecated calls in our code ─────────────

DEPRECATED_LANGSMITH_CALLS = re.compile(
    r"\.(list_runs|get_run_url|read_run|share_run|unshare_run|read_run_shared_link)\("
)


def test_no_deprecated_langsmith_calls_in_the_code() -> None:
    offenders = []
    for path in [
        *AGENT_DIR.glob("ledger_agent/**/*.py"),
        *AGENT_DIR.glob("eval/**/*.py"),
        *AGENT_DIR.glob("scripts/**/*.py"),
    ]:
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if DEPRECATED_LANGSMITH_CALLS.search(line):
                offenders.append(f"{path.relative_to(AGENT_DIR)}:{n}: {line.strip()}")
    assert offenders == [], "use client.runs.query / client.runs.get_url (v2):\n" + "\n".join(offenders)


def test_expect_is_frozen() -> None:
    e = Expect(amounts=frozenset({1}))
    with pytest.raises(AttributeError):
        e.amounts = frozenset()  # type: ignore[misc]


def test_throttle_wait_is_measured_so_the_runner_can_keep_it_out_of_latency() -> None:
    from eval.instrument import MeteredEmbeddings

    now = [0.0]

    def sleep(s: float) -> None:
        now[0] += s

    meter = Meter()
    emb = MeteredEmbeddings(FakeEmbeddings(), meter, Throttle(rpm=1, clock=lambda: now[0], sleep=sleep))
    emb.embed_query("one")
    assert meter.wait_s == 0.0
    emb.embed_query("two")  # second call in the same minute: the throttle holds it ~60 s
    assert 59 < meter.wait_s < 61 and meter.embed_calls == 2
    meter.reset()
    assert meter.wait_s == 0.0
