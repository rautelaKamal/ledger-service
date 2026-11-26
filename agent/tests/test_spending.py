"""Step 7g: "what did I spend last week?" has one meaning, computed by code and checked by code.

The live check on 26 Nov 2026 asked exactly that and got the fallback: the model read paise as
rupees (104200 paise written as ₹1,04,200.00), counted a move between the client's own accounts as
spending, and chose the week itself (Sunday 15 to Saturday 21 Nov). Now the spending tool resolves
the period, sums every account in SQL, leaves out own-account moves and top-ups, and returns the
range; every amount comes with its rupee text; and the verifier requires the range with the total.
"""

from datetime import UTC, date, datetime
from typing import Any

import psycopg
import pytest
from langchain_core.messages import ToolMessage
from psycopg.rows import DictRow

from ledger_agent.config import Settings
from ledger_agent.dates import EN_DASH, IST, NamedPeriod, named_period, period_named_in, period_text
from ledger_agent.prompts import FALLBACK_TEXT
from ledger_agent.service import Assistant
from ledger_agent.verify import Answer, Fetched, verify, with_rupees

from .conftest import Seed
from .fakes import FakeChatModel, FakeEmbeddings, Script, ToolCall

THURSDAY = date(2026, 11, 26)
NOW = datetime(2026, 11, 26, 9, 0, tzinfo=UTC)  # 14:30 IST, Thursday 26 Nov 2026

# ───────────── one meaning per period ─────────────


@pytest.mark.parametrize(
    ("period", "start", "end", "text"),
    [
        ("yesterday", date(2026, 11, 25), date(2026, 11, 25), "25 Nov 2026"),
        ("this_week", date(2026, 11, 23), date(2026, 11, 26), f"23{EN_DASH}26 Nov 2026"),
        ("last_week", date(2026, 11, 16), date(2026, 11, 22), f"16{EN_DASH}22 Nov 2026"),
        ("last_7_days", date(2026, 11, 20), date(2026, 11, 26), f"20{EN_DASH}26 Nov 2026"),
    ],
)
def test_each_period_has_one_meaning(period: NamedPeriod, start: date, end: date, text: str) -> None:
    assert named_period(period, THURSDAY) == (start, end)
    assert period_text(start, end) == text


def test_weeks_run_monday_to_sunday_also_at_their_edges() -> None:
    monday, sunday = date(2026, 11, 23), date(2026, 11, 29)
    assert named_period("this_week", monday) == (monday, monday)
    assert named_period("last_week", monday) == (date(2026, 11, 16), date(2026, 11, 22))
    assert named_period("this_week", sunday) == (monday, sunday)
    assert named_period("last_week", sunday) == (date(2026, 11, 16), date(2026, 11, 22))
    # Across a month and a year.
    assert period_text(*named_period("last_week", date(2026, 12, 2))) == f"23{EN_DASH}29 Nov 2026"
    assert period_text(*named_period("last_7_days", date(2026, 12, 3))) == f"27 Nov{EN_DASH}3 Dec 2026"
    assert period_text(*named_period("last_week", date(2027, 1, 6))) == f"28 Dec 2026{EN_DASH}3 Jan 2027"


@pytest.mark.parametrize(
    ("question", "period"),
    [
        ("what did I spend last week?", "last_week"),
        ("How much did I spend in the previous week", "last_week"),
        ("what have I spent this week?", "this_week"),
        ("What did I spend in the last 7 days?", "last_7_days"),
        ("spending over the past seven days", "last_7_days"),
        ("how much did I spend in the past week", "last_7_days"),
        ("What did I spend yesterday?", "yesterday"),
        ("What did I spend in October?", None),
        ("Compare this week with last week", None),  # two periods: the model decides, nothing is forced
    ],
)
def test_the_question_names_the_period(question: str, period: NamedPeriod | None) -> None:
    assert period_named_in(question) == period


# ───────────── amounts the model copies instead of converting ─────────────


def test_every_paise_amount_comes_with_its_rupee_text() -> None:
    data = {"total_spent_paise": 990125, "payments": [{"amount_paise": 104200}], "count": 2, "ok": True}
    assert with_rupees(data) == {
        "total_spent_paise": 990125,
        "total_spent_inr": "₹9,901.25",
        "payments": [{"amount_paise": 104200, "amount_inr": "₹1,042.00"}],
        "count": 2,
        "ok": True,
    }


# ───────────── the verifier holds the answer to the same range ─────────────


def test_a_spending_total_must_be_stated_with_its_range() -> None:
    fetched = Fetched()
    fetched.absorb({"total_spent_paise": 185300, "period_text": f"16{EN_DASH}22 Nov 2026"})

    def failures(text: str) -> list[str]:
        return verify(Answer(answer=text, citations=[]), fetched, set(), "")

    assert failures(f"From 16{EN_DASH}22 Nov 2026 you spent ₹1,853.00.") == []
    assert failures("From 16-22 Nov 2026 you spent ₹1,853.00.") == []  # a hyphen is the same range
    (problem,) = failures("Last week you spent ₹1,853.00.")
    assert f"is for 16{EN_DASH}22 Nov 2026: state that range" in problem
    assert failures(f"From 15{EN_DASH}21 Nov 2026 you spent ₹1,853.00.")  # the model's own week: refused
    assert failures("You spent nothing worth mentioning.") == []  # no total stated, nothing to check


# ───────────── the ledger: what counts as spending ─────────────


class World:
    """Meera-like: Savings and Current, a payee who is someone else, a month of movements."""

    def __init__(self, seed: Seed) -> None:
        self.ctx = seed.client()
        self.savings = seed.account(self.ctx, "Savings")
        self.current = seed.account(self.ctx, "Current")
        payee = seed.account(seed.client(), "someone else")

        def at(day: int, hour: int, minute: int = 0) -> datetime:
            return datetime(2026, 11, day, hour, minute, tzinfo=IST)

        seed.posted("topup", seed.settlement(), self.savings, 10_000_000, created_at=at(1, 10))
        seed.posted("topup", seed.settlement(), self.current, 100_000, created_at=at(1, 11))
        seed.posted("transfer", self.savings, payee, 77_700, created_at=at(15, 23))  # Sunday before last week
        seed.posted("transfer", self.savings, payee, 104_200, created_at=at(16, 10))  # last week, Monday
        seed.posted("transfer", self.current, payee, 20_000, created_at=at(18, 20))  # last week, other account
        seed.posted("transfer", self.savings, payee, 11_100, created_at=at(20, 8))  # last week and last 7 days
        seed.posted("transfer", self.savings, self.current, 591_225, created_at=at(21, 12))  # own move: not spending
        seed.posted("topup", seed.settlement(), self.current, 500_000, created_at=at(21, 13))  # a top-up: not spending
        seed.posted("transfer", self.savings, payee, 50_000, created_at=at(22, 23, 30))  # last week, Sunday night
        seed.posted("transfer", self.savings, payee, 25_000, created_at=at(23, 0, 30))  # this week, Monday morning
        seed.posted("transfer", self.savings, payee, 30_000, created_at=at(25, 12))  # yesterday
        seed.posted("transfer", self.savings, payee, 10_000, created_at=at(26, 9))  # today


# What each period must add up to in that world.
EXPECTED: dict[str, tuple[str, int, str]] = {
    # question, total paise, total as stated
    "last_week": ("what did I spend last week?", 104_200 + 20_000 + 11_100 + 50_000, "₹1,853.00"),
    "this_week": ("What have I spent this week?", 25_000 + 30_000 + 10_000, "₹650.00"),
    "last_7_days": ("What did I spend in the last 7 days?", 11_100 + 50_000 + 25_000 + 30_000 + 10_000, "₹1,261.00"),
    "yesterday": ("What did I spend yesterday?", 30_000, "₹300.00"),
}


def ask(
    pool: object, settings: Settings, ctx: Any, question: str, rounds: list[list[ToolCall]], answers: list[Answer]
) -> tuple[Any, FakeChatModel]:
    chat = FakeChatModel(script=Script(category="account", rounds=rounds, answers=answers))
    assistant = Assistant(pool, settings, chat, FakeEmbeddings(), now_fn=lambda: NOW)  # type: ignore[arg-type]
    return assistant.ask(ctx, question), chat


def tool_output(chat: FakeChatModel, name: str) -> str:
    return next(
        str(m.content)
        for prompt in chat.prompts
        for m in prompt
        if isinstance(m, ToolMessage) and name in str(m.content)
    )


@pytest.mark.parametrize("period", ["last_week", "this_week", "last_7_days", "yesterday"])
def test_spending_question_answers_with_the_range_and_a_verified_total(
    pool: object, settings: Settings, seed: Seed, period: NamedPeriod
) -> None:
    world = World(seed)
    question, total, stated = EXPECTED[period]
    text = period_text(*named_period(period, THURSDAY))
    assert period_named_in(question) == period
    result, chat = ask(
        pool,
        settings,
        world.ctx,
        question,
        rounds=[[ToolCall("spending", {"period": period})], []],
        answers=[Answer(answer=f"From {text} you spent {stated}.", citations=[])],
    )
    assert result.verified, result.answer
    assert result.answer == f"From {text} you spent {stated}."
    out = tool_output(chat, '"period_text"')
    assert f'"total_spent_paise": {total}' in out and f'"total_spent_inr": "{stated}"' in out
    assert f'"period_text": "{text}"' in out


def test_the_model_cannot_choose_another_week_than_the_question_names(
    pool: object, settings: Settings, seed: Seed, owner: psycopg.Connection[DictRow]
) -> None:
    world = World(seed)
    result, chat = ask(
        pool,
        settings,
        world.ctx,
        "what did I spend last week?",
        # First it tries its own dates (the live check's Sunday-to-Saturday week); the tool refuses.
        rounds=[
            [ToolCall("spending", {"period": "dates", "from_date": "2026-11-15", "to_date": "2026-11-21"})],
            [ToolCall("spending", {"period": "last_week"})],
            [],
        ],
        answers=[Answer(answer=f"From 16{EN_DASH}22 Nov 2026 you spent ₹1,853.00.", citations=[])],
    )
    assert result.verified
    refused = next(
        str(m.content)
        for prompt in chat.prompts
        for m in prompt
        if isinstance(m, ToolMessage) and "the question asks about last week" in str(m.content)
    )
    assert "call spending with period=last_week" in refused
    row = owner.execute("SELECT tools_called FROM agent_runs WHERE id = %s", (result.run_id,)).fetchone()
    assert row is not None and [t["ok"] for t in row["tools_called"]] == [False, True]


def test_an_answer_without_the_range_is_sent_back_once(pool: object, settings: Settings, seed: Seed) -> None:
    world = World(seed)
    result, chat = ask(
        pool,
        settings,
        world.ctx,
        "what did I spend last week?",
        rounds=[[ToolCall("spending", {"period": "last_week"})], []],
        answers=[
            Answer(answer="Last week you spent ₹1,853.00.", citations=[]),
            Answer(answer=f"From 16{EN_DASH}22 Nov 2026 you spent ₹1,853.00.", citations=[]),
        ],
    )
    assert result.verified and result.answer.startswith(f"From 16{EN_DASH}22 Nov 2026")
    assert chat.answer_calls == 2


def test_paise_read_as_rupees_is_still_caught(pool: object, settings: Settings, seed: Seed) -> None:
    """The live check's failure, replayed: the verifier still refuses ₹1,04,200.00 for 104200 paise."""
    world = World(seed)
    result, _ = ask(
        pool,
        settings,
        world.ctx,
        "what did I spend last week?",
        rounds=[[ToolCall("spending", {"period": "last_week"})], []],
        answers=[Answer(answer=f"From 16{EN_DASH}22 Nov 2026 you spent ₹1,04,200.00 on the 16th.", citations=[])],
    )
    assert not result.verified and result.answer == FALLBACK_TEXT


def test_own_account_moves_and_top_ups_are_not_spending(tools: Any, seed: Seed) -> None:
    world = World(seed)
    start, end = named_period("last_week", THURSDAY)
    report = tools.spending(
        world.ctx,
        "last_week",
        start,
        end,
        period_text(start, end),
        datetime(2026, 11, 16, tzinfo=IST),
        datetime(2026, 11, 23, tzinfo=IST),
    )
    assert report.total_spent_paise == 185_300
    assert sorted(p.amount_paise for p in report.payments) == [11_100, 20_000, 50_000, 104_200]
    assert {p.account_id for p in report.payments} == {world.savings, world.current}  # every account
    assert 591_225 not in {p.amount_paise for p in report.payments}  # Savings -> Current is a move
