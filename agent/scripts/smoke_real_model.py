"""Manual smoke test against the REAL model. Not run in CI.

    uv run python scripts/smoke_real_model.py

Needs agent/.env with GOOGLE_API_KEY, AGENT_DATABASE_URL and OWNER_DATABASE_URL,
a migrated database, and ingested policies (scripts/ingest_policies.py).
Seeds one throwaway client (an account, a funding top-up, a transfer out, a
pending top-up) as ledger_owner, asks three questions, prints what came back.
Three questions, by design: the free tier is small.
"""

import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import perf_counter

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ledger_agent.config import load_settings
from ledger_agent.db import ClientContext, create_pool
from ledger_agent.llm import build_chat_model, build_embeddings
from ledger_agent.service import Assistant

QUESTIONS = [
    "Why is my balance lower than last week?",
    "Did my top-up go through?",
    "How long do failed top-ups take to refund?",
]


def seed(owner_url: str) -> ClientContext:
    ctx = ClientContext(client_id=f"smoke-{uuid.uuid4().hex[:8]}")
    other = f"smoke-other-{uuid.uuid4().hex[:6]}"
    with psycopg.connect(owner_url, row_factory=dict_row, autocommit=True) as conn, conn.transaction():

        def account(name: str, owner: str | None) -> uuid.UUID:
            row = conn.execute(
                "INSERT INTO accounts (name, kind, currency, owner_client_id) VALUES (%s, %s, 'INR', %s) RETURNING id",
                (name, "user" if owner else "system", owner),
            ).fetchone()
            assert row is not None
            return uuid.UUID(str(row["id"]))

        def posted(kind: str, debit: uuid.UUID, credit: uuid.UUID, paise: int, note: str, at: datetime) -> None:
            tx = conn.execute(
                "INSERT INTO transactions (kind, note, created_at) VALUES (%s, %s, %s) RETURNING id", (kind, note, at)
            ).fetchone()
            assert tx is not None
            conn.execute(
                """INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
                   VALUES (%s, %s, 'INR', 'debit', %s), (%s, %s, 'INR', 'credit', %s)""",
                (tx["id"], debit, paise, tx["id"], credit, paise),
            )
            conn.execute("UPDATE accounts SET balance_paise = balance_paise - %s WHERE id = %s", (paise, debit))
            conn.execute("UPDATE accounts SET balance_paise = balance_paise + %s WHERE id = %s", (paise, credit))
            conn.execute("UPDATE transactions SET status = 'posted' WHERE id = %s", (tx["id"],))

        bank = conn.execute(
            "SELECT id FROM accounts WHERE kind = 'system' AND name = 'bank_settlement' AND currency = 'INR'"
        ).fetchone()
        bank_id = uuid.UUID(str(bank["id"])) if bank else account("bank_settlement", None)
        mine = account("smoke main", ctx.client_id)
        theirs = account("smoke payee", other)
        now = datetime.now(UTC)
        posted("topup", bank_id, mine, 500_000, "top-up of 500000 INR", now - timedelta(days=12))
        posted("transfer", mine, theirs, 20_000, "rent share", now - timedelta(days=4))
        tx = conn.execute(
            "INSERT INTO transactions (kind, note) VALUES ('topup', 'top-up of 25000 INR') RETURNING id"
        ).fetchone()
        assert tx is not None
        conn.execute(
            "INSERT INTO topups (transaction_id, account_id, currency, amount_paise, provider_payment_id)"
            " VALUES (%s, %s, 'INR', 25000, %s)",
            (tx["id"], mine, f"pay_smoke_{uuid.uuid4().hex}"),
        )
    return ctx


def main() -> int:
    settings = load_settings()
    if not settings.owner_database_url:
        print("OWNER_DATABASE_URL is not set", file=sys.stderr)
        return 1
    ctx = seed(settings.owner_database_url)
    pool = create_pool(settings.database_url, settings.pool_size)
    try:
        assistant = Assistant(pool, settings, build_chat_model(settings), build_embeddings(settings))
        for question in QUESTIONS:
            started = perf_counter()
            result = assistant.ask(ctx, question)
            elapsed = perf_counter() - started
            with pool.connection() as conn:
                conn.execute("SELECT set_config('app.client_id', %s, true)", (ctx.client_id,))
            print(f"\nQ: {question}\nA: {result.answer}")
            print(f"   citations: {[(c.type, c.id) for c in result.citations]}")
            print(f"   verified: {result.verified}   run_id: {result.run_id}   latency: {elapsed:.1f}s")
        print(f"\ntokens per run: see agent_runs rows for client {ctx.client_id} (as ledger_owner)")
    finally:
        pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
