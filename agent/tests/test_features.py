"""The step 7c improvements, each on its own, with the scripted model: fewer calls, same safety."""

import dataclasses
from datetime import UTC, datetime, timedelta

import psycopg
from langchain_core.messages import SystemMessage, ToolMessage
from psycopg.rows import DictRow

from ledger_agent.config import Settings
from ledger_agent.graph import ANSWER_TOOL, CLASSIFY, COMPACT, PREFETCH, TOPUPS
from ledger_agent.service import Assistant
from ledger_agent.verify import Answer, Citation

from .conftest import Seed
from .fakes import FakeChatModel, FakeEmbeddings, Script, ToolCall

NOW = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)


def assistant(pool: object, settings: Settings, script: Script, *features: str) -> tuple[Assistant, FakeChatModel]:
    chat = FakeChatModel(script=script)
    s = dataclasses.replace(settings, features=frozenset(features))
    return Assistant(pool, s, chat, FakeEmbeddings(), now_fn=lambda: NOW), chat  # type: ignore[arg-type]


def tool_messages(chat: FakeChatModel) -> list[ToolMessage]:
    last = max(chat.prompts, key=lambda p: sum(isinstance(m, ToolMessage) for m in p))
    return [m for m in last if isinstance(m, ToolMessage)]


def test_prefetch_puts_accounts_and_totals_in_the_prompt_and_makes_a_total_verifiable(
    pool: object, settings: Settings, seed: Seed
) -> None:
    ctx = seed.client()
    main, savings = seed.account(ctx, "main"), seed.account(ctx, "savings")
    seed.posted("topup", seed.settlement(), main, 12_000)
    seed.posted("topup", seed.settlement(), savings, 30_000)
    # The model asks for nothing: the accounts and the total are already there.
    script = Script(rounds=[[]], answers=[Answer(answer="Across both accounts you have ₹420.00.")])
    a, chat = assistant(pool, settings, script, PREFETCH)

    result = a.ask(ctx, "how much do I have in total?")

    assert result.verified  # ₹420.00 is the server-computed total, so the verifier accepts it
    assert result.chat_calls == 3  # classify, one fetch round, answer: no list_my_accounts round
    assert ("list_my_accounts", True) in result.tools
    first_fetch_prompt = next(p for p in chat.prompts if any("list_my_accounts" in str(m.content) for m in p[1:2]))
    assert '"total_balance_paise": 42000' in str(first_fetch_prompt[1].content)
    system = next(m for m in chat.prompts[0] if isinstance(m, SystemMessage))
    assert "do not call list_my_accounts" in str(system.content)


def test_without_prefetch_the_same_total_is_refused_by_the_verifier(
    pool: object, settings: Settings, seed: Seed
) -> None:
    ctx = seed.client()
    main, savings = seed.account(ctx, "main"), seed.account(ctx, "savings")
    seed.posted("topup", seed.settlement(), main, 12_000)
    seed.posted("topup", seed.settlement(), savings, 30_000)
    sum_by_model = Answer(answer="Across both accounts you have ₹420.00.")
    a, _ = assistant(
        pool, settings, Script(rounds=[[ToolCall("list_my_accounts", {})], []], answers=[sum_by_model, sum_by_model])
    )
    result = a.ask(ctx, "how much do I have in total?")
    assert not result.verified  # the model added two numbers; nothing fetched says 420.00


def test_answer_tool_submits_in_the_loop_and_saves_two_calls(
    pool: object, settings: Settings, seed: Seed, owner: psycopg.Connection[DictRow]
) -> None:
    ctx = seed.client()
    acct = seed.account(ctx, "main")
    seed.posted("topup", seed.settlement(), acct, 9_900, created_at=NOW - timedelta(days=2))
    script = Script(
        rounds=[
            [ToolCall("list_transactions", {"account_id": str(acct)})],
            [ToolCall("submit_answer", {"answer": "You received ₹99.00.", "citations": []})],
        ]
    )
    a, _ = assistant(pool, settings, script, PREFETCH, ANSWER_TOOL)

    result = a.ask(ctx, "what came in recently?")

    assert result.verified and result.answer == "You received ₹99.00."
    assert result.chat_calls == 3  # classify + 2 rounds; before: classify + 2 tool rounds + 'done' round + answer = 5
    row = owner.execute("SELECT attempts FROM agent_runs WHERE id = %s", (result.run_id,)).fetchone()
    assert row is not None and row["attempts"] == 1


def test_answer_tool_regenerates_through_the_answer_step_when_verification_fails(
    pool: object, settings: Settings, seed: Seed
) -> None:
    ctx = seed.client()
    acct = seed.account(ctx, "main")
    seed.posted("topup", seed.settlement(), acct, 9_900, created_at=NOW - timedelta(days=2))
    script = Script(
        rounds=[[ToolCall("submit_answer", {"answer": "You have ₹1,00,00,000.00.", "citations": []})]],
        answers=[Answer(answer="You have ₹99.00.")],
    )
    a, chat = assistant(pool, settings, script, PREFETCH, ANSWER_TOOL)
    result = a.ask(ctx, "balance?")
    assert result.verified and result.answer == "You have ₹99.00."
    # The regeneration prompt carried the prefetched accounts and the verifier's feedback.
    regen = chat.prompts[-1]
    assert "could not be verified" in str(regen[1].content) and "list_my_accounts" in str(regen[1].content)


def test_answer_tool_with_a_both_question_retrieves_first_and_answers_in_one_round(
    pool: object, settings: Settings, seed: Seed, ingested: None
) -> None:
    ctx = seed.client()
    seed.account(ctx, "main")
    script = Script(
        category="both",
        rounds=[[ToolCall("submit_answer", {"answer": "Refunds take 1 to 3 business days.", "citations": []})]],
    )
    a, chat = assistant(pool, settings, script, PREFETCH, ANSWER_TOOL)
    result = a.ask(ctx, "my top-up failed, when do I get a refund?")
    assert result.verified and result.chat_calls == 2 and result.embed_calls == 1
    assert 'source="policy" id=' in str(chat.prompts[1][1].content)  # the policies were in the tool round's prompt


def test_a_malformed_submit_falls_back_to_the_answer_step(pool: object, settings: Settings, seed: Seed) -> None:
    ctx = seed.client()
    seed.account(ctx, "main")
    script = Script(rounds=[[ToolCall("submit_answer", {"citations": "not a list"})]], answers=[Answer(answer="ok")])
    a, _ = assistant(pool, settings, script, ANSWER_TOOL)
    result = a.ask(ctx, "anything")
    assert result.answer == "ok" and result.verified


def test_topups_tool_lists_every_top_up_across_accounts(pool: object, settings: Settings, seed: Seed) -> None:
    ctx = seed.client()
    main, savings = seed.account(ctx, "main"), seed.account(ctx, "savings")
    posted = seed.posted("topup", seed.settlement(), main, 30_000, created_at=NOW - timedelta(days=3))
    pending = seed.pending_topup(savings, 10_000)
    script = Script(
        rounds=[[ToolCall("list_my_topups", {"from_date": "2026-11-01", "to_date": "2026-11-30"})], []],
        answers=[Answer(answer="One ₹100.00 top-up is pending; nothing else.")],
    )
    a, chat = assistant(pool, settings, script, TOPUPS)
    result = a.ask(ctx, "did my top-ups go through?")
    assert ("list_my_topups", True) in result.tools
    listed = str(tool_messages(chat)[0].content)
    assert str(pending) in listed and '"status": "pending"' in listed
    assert str(posted) not in listed  # a seeded posted transaction has no topups row: only real top-ups are listed
    system = next(m for m in chat.prompts[0] if isinstance(m, SystemMessage))
    assert "cover every item in that period" in str(system.content)
    assert "state its amount" in str(system.content)


def test_classify_hints_reach_the_classifier_only_when_switched_on(
    pool: object, settings: Settings, seed: Seed
) -> None:
    ctx = seed.client()
    seed.account(ctx, "main")
    for features, expected in (((), False), ((CLASSIFY,), True)):
        script = Script(category="out_of_scope", rounds=[])
        a, chat = assistant(pool, settings, script, *features)
        a.ask(ctx, "What was the transfer from Dev about?")
        classify_prompt = str(chat.prompts[0][-1].content)
        assert ("Only another person's own accounts" in classify_prompt) is expected
        assert "Question: What was the transfer from Dev about?" in classify_prompt


def test_compact_tool_output_has_no_indentation(pool: object, settings: Settings, seed: Seed) -> None:
    ctx = seed.client()
    acct = seed.account(ctx, "main")
    seed.posted("topup", seed.settlement(), acct, 500, created_at=NOW - timedelta(days=1))
    script = Script(
        rounds=[[ToolCall("list_transactions", {"account_id": str(acct)})], []], answers=[Answer(answer="₹5.00")]
    )
    a, chat = assistant(pool, settings, script, COMPACT)
    a.ask(ctx, "recent?")
    lines = str(tool_messages(chat)[0].content).split("\n")
    assert len(lines) == 3, lines[:5]  # the opening tag, the whole JSON on ONE line, the closing tag
    assert lines[1].startswith("{") and '"note":null' not in lines[1].replace(" ", "")  # no empty fields


def test_citations_survive_the_answer_tool(pool: object, settings: Settings, seed: Seed) -> None:
    ctx = seed.client()
    acct = seed.account(ctx, "main")
    tx = seed.posted("topup", seed.settlement(), acct, 700, created_at=NOW - timedelta(days=1))
    script = Script(
        rounds=[
            [ToolCall("explain_transaction", {"transaction_id": str(tx)})],
            [
                ToolCall(
                    "submit_answer", {"answer": "₹7.00 came in.", "citations": [{"type": "transaction", "id": str(tx)}]}
                )
            ],
        ]
    )
    a, _ = assistant(pool, settings, script, ANSWER_TOOL)
    result = a.ask(ctx, "explain it")
    assert result.verified and result.citations == [Citation(type="transaction", id=str(tx))]
