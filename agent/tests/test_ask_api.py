"""POST /ask: the header, the cap, upstream failures, and what gets recorded."""

import re
from collections.abc import Callable
from datetime import UTC, datetime

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import DictRow

from ledger_agent.api import create_app
from ledger_agent.config import Settings
from ledger_agent.notes import copies_a_note
from ledger_agent.verify import Answer, Citation

from .conftest import Seed
from .fakes import FakeChatModel, FakeEmbeddings, Script, ToolCall

NOW = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)


def client_for(settings: Settings, script: Script) -> tuple[TestClient, FakeChatModel]:
    chat = FakeChatModel(script=script)
    app = create_app(settings, chat=chat, embeddings=FakeEmbeddings(), now_fn=lambda: NOW)
    return TestClient(app), chat


def runs_for(owner: psycopg.Connection[DictRow], client_id: str) -> int:
    row = owner.execute("SELECT count(*) AS n FROM agent_runs WHERE client_id = %s", (client_id,)).fetchone()
    assert row is not None
    return int(row["n"])


def test_ask_requires_the_client_header_and_a_question(settings: Settings) -> None:
    client, _ = client_for(settings, Script(category="out_of_scope"))
    with client:
        assert client.post("/ask", json={"question": "hi"}).status_code == 400
        assert client.post("/ask", json={"question": ""}, headers={"X-Client-Id": "a"}).status_code == 422
        assert (
            client.post("/ask", json={"question": "hi", "client_id": "b"}, headers={"X-Client-Id": "a"}).status_code
            == 422
        )


def test_ask_answers_and_records_a_run(settings: Settings, seed: Seed, owner: psycopg.Connection[DictRow]) -> None:
    ctx = seed.client()
    acct = seed.account(ctx, "main")
    seed.posted("topup", seed.settlement(), acct, 4_200)
    client, _ = client_for(
        settings,
        Script(rounds=[[ToolCall("list_my_accounts", {})], []], answers=[Answer(answer="Your balance is ₹42.00.")]),
    )
    with client:
        res = client.post("/ask", json={"question": "balance?"}, headers={"X-Client-Id": ctx.client_id})
    assert res.status_code == 200
    body = res.json()
    assert body == {
        "answer": "Your balance is ₹42.00.",
        "citations": [],
        "verified": True,
        "run_id": body["run_id"],
        "notes": [],
    }
    assert runs_for(owner, ctx.client_id) == 1


def test_every_answer_logs_its_model_calls_and_where_the_time_went(
    settings: Settings, seed: Seed, caplog: pytest.LogCaptureFixture
) -> None:
    ctx = seed.client()
    acct = seed.account(ctx, "main")
    seed.posted("topup", seed.settlement(), acct, 4_200)
    client, _ = client_for(
        settings,
        Script(rounds=[[ToolCall("list_my_accounts", {})], []], answers=[Answer(answer="Your balance is ₹42.00.")]),
    )
    with caplog.at_level("INFO", logger="ledger_agent"), client:
        res = client.post("/ask", json={"question": "my balance?"}, headers={"X-Client-Id": ctx.client_id})
    assert res.status_code == 200
    (line,) = [r.getMessage() for r in caplog.records if r.getMessage().startswith("answered ")]
    # classify + two fetch rounds + the answer = 4 chat calls; one tool; each step timed.
    assert "category=account verified=True attempts=1 chat_calls=4 embed_calls=0 tool_calls=1" in line
    assert re.search(r"total_s=\d+\.\d\d model_s=\d+\.\d\d tool_s=\d+\.\d\d", line)
    assert re.search(
        r"steps=route:\d+\.\d\d classify:\d+\.\d\d fetch:\d+\.\d\d answer:\d+\.\d\d check:\d+\.\d\d$", line
    )
    assert "my balance" not in line and ctx.client_id not in line  # counts and seconds only


def test_the_services_info_lines_reach_the_pod_log(settings: Settings) -> None:
    """In a fresh process, "ledger_agent" inherits WARNING from the root logger: INFO must be switched on."""
    import logging

    logger = logging.getLogger("ledger_agent")
    saved_level, saved_handlers = logger.level, list(logger.handlers)
    logger.setLevel(logging.NOTSET)
    logger.handlers.clear()
    root_level = logging.getLogger().level
    logging.getLogger().setLevel(logging.WARNING)  # what a fresh process has (pytest may change it)
    try:
        assert not logger.isEnabledFor(logging.INFO)  # the bug the live check found
        client_for(settings, Script())
        assert logger.isEnabledFor(logging.INFO)
        assert [h for h in logger.handlers if isinstance(h, logging.StreamHandler)]
        client_for(settings, Script())  # a second app adds no second handler
        assert len(logger.handlers) == 1
    finally:
        logger.setLevel(saved_level)
        logger.handlers[:] = saved_handlers
        logging.getLogger().setLevel(root_level)


def test_rate_limit_is_checked_before_any_model_call(
    settings: Settings, seed: Seed, owner: psycopg.Connection[DictRow]
) -> None:
    ctx = seed.client()
    limited = Settings(database_url=settings.database_url, pool_size=2, daily_limit=2)
    client, chat = client_for(limited, Script(category="out_of_scope"))
    with client:
        headers = {"X-Client-Id": ctx.client_id}
        assert client.post("/ask", json={"question": "one"}, headers=headers).status_code == 200
        assert client.post("/ask", json={"question": "two"}, headers=headers).status_code == 200
        calls_before = len(chat.prompts)
        third = client.post("/ask", json={"question": "three"}, headers=headers)
    assert third.status_code == 429 and third.headers["retry-after"] == "3600"
    assert third.json()["error"]["code"] == "rate_limited"
    assert len(chat.prompts) == calls_before  # the model was never asked
    assert runs_for(owner, ctx.client_id) == 2


def test_upstream_failure_is_503_and_does_not_count(
    settings: Settings, seed: Seed, owner: psycopg.Connection[DictRow]
) -> None:
    ctx = seed.client()
    limited = Settings(database_url=settings.database_url, pool_size=2, daily_limit=1)
    outage = RuntimeError("503 UNAVAILABLE. This model is currently experiencing high demand.")
    client, chat = client_for(limited, Script(category="account", fail_with=outage))
    with client:
        headers = {"X-Client-Id": ctx.client_id}
        res = client.post("/ask", json={"question": "balance?"}, headers=headers)
        assert res.status_code == 503 and res.headers["retry-after"] == "30"
        assert res.json()["error"]["code"] == "model_unavailable"
        assert runs_for(owner, ctx.client_id) == 0  # logged, not recorded ...
        chat.script.fail_with = None
        chat.script.category = "out_of_scope"
        ok = client.post("/ask", json={"question": "again"}, headers=headers)
    assert ok.status_code == 200  # ... so it did not use up the (single) daily question
    assert runs_for(owner, ctx.client_id) == 1


def _chat_rate_limit() -> Exception:
    """What ChatGoogleGenerativeAI raises on HTTP 429 (a langchain ModelRateLimitError)."""
    from langchain_google_genai.chat_models import GoogleRateLimitError

    return GoogleRateLimitError("Error calling model 'gemini-3.5-flash-lite' (RESOURCE_EXHAUSTED): 429")


def _embedding_quota() -> Exception:
    """What GoogleGenerativeAIEmbeddings raises on HTTP 429: a generic error caused by a ClientError."""
    from google.genai.errors import ClientError

    quota = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded"}}
    try:
        try:
            raise ClientError(429, quota)
        except ClientError as e:
            raise RuntimeError("Error embedding content: quota") from e
    except RuntimeError as outer:
        return outer


@pytest.mark.parametrize("make_error", [_chat_rate_limit, _embedding_quota], ids=["chat-429", "embedding-429"])
def test_provider_quota_is_503_model_quota_and_does_not_count(
    settings: Settings, seed: Seed, owner: psycopg.Connection[DictRow], make_error: Callable[[], Exception]
) -> None:
    ctx = seed.client()
    client, _ = client_for(settings, Script(category="account", fail_with=make_error()))
    with client:
        res = client.post("/ask", json={"question": "balance?"}, headers={"X-Client-Id": ctx.client_id})
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "model_quota"  # the web app shows a labelled scripted answer
    assert runs_for(owner, ctx.client_id) == 0  # not the client's question either


def test_quota_is_told_by_type_and_code_never_by_message_text() -> None:
    from ledger_agent.llm import is_quota_error

    assert is_quota_error(_chat_rate_limit()) and is_quota_error(_embedding_quota())
    assert not is_quota_error(RuntimeError("429 RESOURCE_EXHAUSTED"))  # just text
    assert not is_quota_error(RuntimeError("503 UNAVAILABLE"))


def test_agent_cannot_insert_a_run_for_another_client(pool: object, seed: Seed) -> None:
    import pytest

    from ledger_agent.db import client_scope
    from ledger_agent.runs import RunRecord, insert_run

    me, them = seed.client(), seed.client()
    record = RunRecord(
        question="q", category="account", answer="a", verified=True, attempts=1, model="fake", latency_ms=1
    )
    # Through the service's own code path (INSERT ... RETURNING id) ...
    with pytest.raises(psycopg.errors.InsufficientPrivilege), client_scope(pool, me, read_only=False) as conn:  # type: ignore[arg-type]
        insert_run(conn, them.client_id, record)
    # ... and as a bare INSERT without RETURNING. RETURNING is also checked against
    # the SELECT policy, so this second case is what proves the INSERT policy itself.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), client_scope(pool, me, read_only=False) as conn:  # type: ignore[arg-type]
        conn.execute(
            "INSERT INTO agent_runs (client_id, question, category, answer, verified, attempts, model, latency_ms)"
            " VALUES (%s, 'q', 'account', 'a', true, 1, 'fake', 1)",
            (them.client_id,),
        )
    # The same bare INSERT for the client in scope is allowed: the refusal above is about WHO.
    with client_scope(pool, me, read_only=False) as conn:  # type: ignore[arg-type]
        conn.execute(
            "INSERT INTO agent_runs (client_id, question, category, answer, verified, attempts, model, latency_ms)"
            " VALUES (%s, 'q', 'account', 'a', true, 1, 'fake', 1)",
            (me.client_id,),
        )


def test_metrics_count_outcomes_calls_and_tokens_without_client_data(
    settings: Settings, seed: Seed, owner: psycopg.Connection[DictRow]
) -> None:
    from prometheus_client import generate_latest

    ctx = seed.client()
    acct = seed.account(ctx, "main")
    seed.posted("topup", seed.settlement(), acct, 4_200)
    limited = Settings(database_url=settings.database_url, pool_size=2, daily_limit=2)
    client, chat = client_for(
        limited,
        Script(rounds=[[ToolCall("list_my_accounts", {})], []], answers=[Answer(answer="Your balance is ₹42.00.")]),
    )
    with client:
        headers = {"X-Client-Id": ctx.client_id}
        assert client.post("/ask", json={"question": "balance?"}, headers=headers).status_code == 200
        chat.script.category = "out_of_scope"
        assert client.post("/ask", json={"question": "weather?"}, headers=headers).status_code == 200
        assert client.post("/ask", json={"question": "third"}, headers=headers).status_code == 429
        assert client.post("/ask", json={"question": "no header"}).status_code == 400
        text = generate_latest(client.app.state.metrics.registry).decode()  # type: ignore[attr-defined]

    def value(series: str) -> float:
        line = next(line for line in text.splitlines() if line.startswith(series + " "))
        return float(line.split()[-1])

    assert value('agent_questions_total{category="account",outcome="verified"}') == 1
    assert value('agent_questions_total{category="out_of_scope",outcome="refused"}') == 1
    assert value('agent_questions_total{category="none",outcome="rate_limited"}') == 1
    assert value('agent_questions_total{category="none",outcome="bad_request"}') == 1
    assert value('agent_model_calls_total{kind="chat"}') == 5  # classify + 2 tool rounds + answer, then classify
    assert value('agent_tool_calls_total{ok="true",tool="list_my_accounts"}') == 1
    assert value('agent_question_duration_seconds_count{category="account"}') == 1
    assert ctx.client_id not in text and "balance" not in text.lower()  # no client ids, no questions or answers


NOTE_20 = (  # 20 words, legitimate
    "Deposit for the two bedroom flat on Park Street with the first month of rent and the keys handed over"
)


def test_a_long_note_is_returned_in_full_by_code_and_never_copied_by_the_model(
    settings: Settings, seed: Seed, owner: psycopg.Connection[DictRow]
) -> None:
    """What was it for? The answer says it in a few words and cites it; the note comes from the database."""
    ctx, other = seed.client(), seed.client()
    acct = seed.account(ctx, "main")
    payee = seed.account(other, "landlord")
    seed.posted("topup", seed.settlement(), acct, 2_000_000)
    tx = seed.posted("transfer", acct, payee, 900_000, note=NOTE_20)
    cite = [Citation(type="transaction", id=str(tx))]
    copied = Answer(answer=f"₹9,000.00: {NOTE_20}.", citations=cite)
    own_words = Answer(answer="That ₹9,000.00 was the deposit for a flat.", citations=cite)
    script = Script(
        rounds=[[ToolCall("explain_transaction", {"transaction_id": str(tx)})], []], answers=[copied, own_words]
    )
    client, _ = client_for(settings, script)
    with client:
        res = client.post(
            "/ask", json={"question": "What was my ₹9,000.00 transfer for?"}, headers={"X-Client-Id": ctx.client_id}
        )
    body = res.json()
    assert res.status_code == 200 and body["verified"] is True
    assert body["answer"] == own_words.answer and not copies_a_note(body["answer"], {NOTE_20})
    assert body["notes"] == [{"transaction_id": str(tx), "text": NOTE_20}]  # in full, from the ledger


def test_no_note_is_returned_when_the_question_is_not_about_one(settings: Settings, seed: Seed) -> None:
    ctx, other = seed.client(), seed.client()
    acct = seed.account(ctx, "main")
    seed.posted("topup", seed.settlement(), acct, 2_000_000)
    tx = seed.posted("transfer", acct, seed.account(other, "landlord"), 900_000, note=NOTE_20)
    cite = [Citation(type="transaction", id=str(tx))]
    script = Script(
        rounds=[[ToolCall("list_my_accounts", {})], []],
        answers=[Answer(answer="Your balance is ₹11,000.00.", citations=cite)],
    )
    client, _ = client_for(settings, script)
    with client:
        res = client.post("/ask", json={"question": "What is my balance?"}, headers={"X-Client-Id": ctx.client_id})
    assert res.json()["notes"] == []
