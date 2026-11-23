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
from typing import Any, cast

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from ledger_agent.config import Settings
from ledger_agent.db import ClientContext, create_pool
from ledger_agent.tools import LedgerTools

ENV_FILE = Path(__file__).resolve().parents[2] / ".env.test"


def _env(name: str) -> str:
    lines = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    found = [ln.split("=", 1)[1].strip() for ln in lines if ln.startswith(f"{name}=")]
    if name in os.environ:
        value = os.environ[name]
    elif found:
        value = found[0]
    else:
        raise RuntimeError(f"{name} is not set (and {ENV_FILE} has no value for it)")
    return require_test_database(name, value) if name.endswith("DATABASE_URL") else value


def require_test_database(name: str, url: str) -> str:
    """These tests write (seed data, policy chunks with FAKE embeddings). They may only
    ever do that to a database whose name ends in _test: on 18 Nov 2026 a run against
    the eval's database replaced its real policy embeddings with fake ones."""
    dbname = conninfo_to_dict(url).get("dbname") or ""
    if not str(dbname).endswith("_test"):
        raise RuntimeError(
            f"{name} points at database {dbname!r}: the agent tests only run against a database named *_test"
        )
    return url


def clear_langsmith_env_cache() -> None:
    """langsmith.utils.get_env_var is an lru_cache behind typing overloads (which hide cache_clear from mypy)."""
    from langsmith import utils as ls_utils

    cast(Any, ls_utils.get_env_var).cache_clear()


@pytest.fixture(autouse=True)
def no_tracing(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No test ever sends a trace, whatever the developer's shell or agent/.env says.

    langsmith caches its environment lookups (functools.lru_cache), so removing
    the variables is not enough: the cache is cleared before and after each test.
    """
    from ledger_agent.config import TRACING_VARS

    for var in (*TRACING_VARS, "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    clear_langsmith_env_cache()
    yield
    clear_langsmith_env_cache()


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
def pool(settings: Settings) -> Iterator[ConnectionPool[psycopg.Connection[DictRow]]]:
    p = create_pool(settings.database_url, settings.pool_size)
    try:
        yield p
    finally:
        p.close()


@pytest.fixture(scope="session")
def tools(pool: ConnectionPool[psycopg.Connection[DictRow]]) -> LedgerTools:
    return LedgerTools(pool)


@pytest.fixture(scope="session")
def ingested(owner: psycopg.Connection[DictRow]) -> None:
    """The real policy documents, embedded with the fake embedder, once per session."""
    from ledger_agent.rag import sync_policies

    from .fakes import FakeEmbeddings

    sync_policies(owner, FakeEmbeddings(), Path(__file__).resolve().parents[1] / "policies", "fake-768")


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
