"""Fixtures: a real Postgres (ledger_test), seeded as ledger_owner, read as ledger_agent.

Environment: AGENT_DATABASE_URL and OWNER_DATABASE_URL, from the process
environment or, failing that, from ../.env.test (the TypeScript tests' file).
The database must be migrated (npm test does that; CI runs the migrations first).
"""

import os
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import psycopg
import pytest
from psycopg.rows import DictRow, dict_row

from ledger_agent.config import Settings
from ledger_agent.db import ClientContext, create_pool
from ledger_agent.tools import LedgerTools

ENV_FILE = Path(__file__).resolve().parents[2] / ".env.test"


def _env(name: str) -> str:
    if name in os.environ:
        return os.environ[name]
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError(f"{name} is not set (and {ENV_FILE} has no value for it)")


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(database_url=_env("AGENT_DATABASE_URL"), pool_size=2)


@pytest.fixture(scope="session")
def owner() -> Iterator[psycopg.Connection[DictRow]]:
    conn = psycopg.connect(_env("OWNER_DATABASE_URL"), row_factory=dict_row, autocommit=True)
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture(scope="session")
def tools(settings: Settings) -> Iterator[LedgerTools]:
    pool = create_pool(settings.database_url, settings.pool_size)
    try:
        yield LedgerTools(pool)
    finally:
        pool.close()


class Seed:
    """Writes test data as ledger_owner, the way the API would have."""

    def __init__(self, conn: psycopg.Connection[DictRow]) -> None:
        self.conn = conn

    def client(self) -> ClientContext:
        return ClientContext(client_id=f"py-{uuid.uuid4().hex[:8]}")

    def account(self, ctx: ClientContext | None, name: str = "acct", currency: str = "INR") -> uuid.UUID:
        row = self.conn.execute(
            "INSERT INTO accounts (name, kind, currency, owner_client_id) VALUES (%s, %s, %s, %s) RETURNING id",
            (name, "user" if ctx else "system", currency, ctx.client_id if ctx else None),
        ).fetchone()
        assert row is not None
        return cast(uuid.UUID, row["id"])

    def settlement(self, currency: str = "INR") -> uuid.UUID:
        row = self.conn.execute(
            "SELECT id FROM accounts WHERE kind = 'system' AND name = 'bank_settlement' AND currency = %s", (currency,)
        ).fetchone()
        if row:
            return cast(uuid.UUID, row["id"])
        return self.account(None, "bank_settlement", currency)

    def posted(
        self,
        kind: str,
        debit: uuid.UUID,
        credit: uuid.UUID,
        paise: int,
        note: str | None = None,
        created_at: datetime | None = None,
        currency: str = "INR",
    ) -> uuid.UUID:
        """A balanced, posted two-leg transaction that also moves the cached balances."""
        with self.conn.transaction():
            tx = self.conn.execute(
                "INSERT INTO transactions (kind, note, created_at) VALUES (%s, %s, %s) RETURNING id",
                (kind, note, created_at or datetime.now(UTC)),
            ).fetchone()
            assert tx is not None
            tx_id: uuid.UUID = tx["id"]
            self.conn.execute(
                """INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
                   VALUES (%s, %s, %s, 'debit', %s), (%s, %s, %s, 'credit', %s)""",
                (tx_id, debit, currency, paise, tx_id, credit, currency, paise),
            )
            self.conn.execute("UPDATE accounts SET balance_paise = balance_paise - %s WHERE id = %s", (paise, debit))
            self.conn.execute("UPDATE accounts SET balance_paise = balance_paise + %s WHERE id = %s", (paise, credit))
            self.conn.execute("UPDATE transactions SET status = 'posted' WHERE id = %s", (tx_id,))
        return tx_id

    def pending_topup(self, account: uuid.UUID, paise: int, currency: str = "INR") -> uuid.UUID:
        with self.conn.transaction():
            tx = self.conn.execute(
                "INSERT INTO transactions (kind, note) VALUES ('topup', %s) RETURNING id",
                (f"top-up of {paise} {currency}",),
            ).fetchone()
            assert tx is not None
            self.conn.execute(
                "INSERT INTO topups (transaction_id, account_id, currency, amount_paise, provider_payment_id)"
                " VALUES (%s, %s, %s, %s, %s)",
                (tx["id"], account, currency, paise, f"pay_{uuid.uuid4().hex}"),
            )
        return cast(uuid.UUID, tx["id"])


@pytest.fixture
def seed(owner: psycopg.Connection[DictRow]) -> Seed:
    return Seed(owner)
