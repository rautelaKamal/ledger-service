"""The assistant's tools: plain functions, typed in and out, read-only.

Every tool takes the ClientContext FIRST and reads through the agent_* views
inside `client_scope`, so Postgres only ever returns that client's rows.
Money is integer paise end to end: Postgres BIGINT -> Python int -> the
models' `int` fields. No float is ever involved. Arithmetic (period totals,
opening and closing balances) is done here, in SQL, never by a model.

"Not found" covers both "does not exist" and "not yours": the views simply do
not contain other clients' rows, so the tools cannot tell the difference, and
neither can the caller.
"""

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

import psycopg
from psycopg.rows import DictRow
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict

from .db import ClientContext, client_scope
from .notes import UserNote

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def _note(text: str | None, include: bool) -> UserNote | None:
    return UserNote(text=text) if include and text else None


class NotFoundError(Exception):
    """The account or transaction does not exist for this client."""


class AccountInfo(BaseModel):
    model_config = ConfigDict(frozen=True)

    account_id: UUID
    name: str
    currency: str
    balance_paise: int


class Balance(BaseModel):
    model_config = ConfigDict(frozen=True)

    account_id: UUID
    name: str
    currency: str
    balance_paise: int
    as_of: datetime


class Leg(BaseModel):
    """One side of a transaction. own_account: this leg is on the client's account."""

    model_config = ConfigDict(frozen=True)

    account_id: UUID
    direction: Literal["debit", "credit"]
    amount_paise: int
    currency: str
    own_account: bool


class TopupStatus(BaseModel):
    model_config = ConfigDict(frozen=True)

    account_id: UUID
    amount_paise: int
    currency: str
    status: Literal["pending", "posted", "failed"]


class TransactionSummary(BaseModel):
    """A transaction as seen from one account: money in, money out, or a top-up not posted yet."""

    model_config = ConfigDict(frozen=True)

    transaction_id: UUID
    kind: Literal["transfer", "topup", "refund", "opening"]
    status: Literal["pending", "posted", "failed"]
    note: UserNote | None  # only when the question asks for notes (include_notes)
    created_at: datetime
    posted_at: datetime | None
    # 'in'/'out' for a posted movement on this account; None for a top-up that has no entries yet
    direction: Literal["in", "out"] | None
    amount_paise: int
    counterparty_account_id: UUID | None


class TransactionsReport(BaseModel):
    """Movements on one account in [from, to), plus the arithmetic a model must never do itself."""

    model_config = ConfigDict(frozen=True)

    account_id: UUID
    period_from: datetime
    period_to: datetime
    opening_balance_paise: int
    closing_balance_paise: int
    total_in_paise: int
    total_out_paise: int
    net_change_paise: int
    transactions: list[TransactionSummary]


class TopupItem(BaseModel):
    """One top-up onto one of the client's accounts (step 7c, list_my_topups)."""

    model_config = ConfigDict(frozen=True)

    transaction_id: UUID
    account_id: UUID
    amount_paise: int
    currency: str
    status: Literal["pending", "posted", "failed"]
    created_at: datetime


class TransactionDetail(BaseModel):
    model_config = ConfigDict(frozen=True)

    transaction_id: UUID
    kind: Literal["transfer", "topup", "refund", "opening"]
    status: Literal["pending", "posted", "failed"]
    note: UserNote | None  # only when the question asks for notes (include_notes)
    created_at: datetime
    posted_at: datetime | None
    legs: list[Leg]
    topup: TopupStatus | None


class LedgerTools:
    """The read-only tools, bound to a connection pool (role ledger_agent)."""

    def __init__(self, pool: ConnectionPool[psycopg.Connection[DictRow]]) -> None:
        self._pool = pool

    def list_accounts(self, ctx: ClientContext) -> list[AccountInfo]:
        with client_scope(self._pool, ctx) as conn:
            rows = conn.execute("SELECT id, name, currency, balance_paise FROM agent_accounts ORDER BY name").fetchall()
        return [
            AccountInfo(account_id=r["id"], name=r["name"], currency=r["currency"], balance_paise=r["balance_paise"])
            for r in rows
        ]

    def get_balance(self, ctx: ClientContext, account_id: UUID) -> Balance:
        with client_scope(self._pool, ctx) as conn:
            row = conn.execute(
                "SELECT id, name, currency, balance_paise, now() AS as_of FROM agent_accounts WHERE id = %s",
                (account_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"account {account_id} not found")
        return Balance(
            account_id=row["id"],
            name=row["name"],
            currency=row["currency"],
            balance_paise=row["balance_paise"],
            as_of=row["as_of"],
        )

    def list_transactions(
        self,
        ctx: ClientContext,
        account_id: UUID,
        from_: datetime | None = None,
        to: datetime | None = None,
        limit: int = DEFAULT_LIMIT,
        include_notes: bool = False,
    ) -> TransactionsReport:
        """Movements on one account, newest first, within [from_, to), with period totals.

        Notes are left out unless include_notes: they are text other clients can write (notes.py).
        """
        limit = max(1, min(limit, MAX_LIMIT))
        from_ = from_ or datetime(1970, 1, 1, tzinfo=UTC)
        to = to or datetime(9999, 12, 31, tzinfo=UTC)
        with client_scope(self._pool, ctx) as conn:
            account = conn.execute("SELECT balance_paise FROM agent_accounts WHERE id = %s", (account_id,)).fetchone()
            if account is None:
                raise NotFoundError(f"account {account_id} not found")
            # Posted movements: the client's own leg on this account, plus the other side.
            moved = conn.execute(
                """
                SELECT t.id, t.kind, t.status, t.note, t.created_at, t.posted_at,
                       e.direction, e.amount_paise,
                       (SELECT o.account_id FROM agent_entries o
                         WHERE o.transaction_id = t.id AND o.account_id <> e.account_id
                         LIMIT 1) AS counterparty_account_id
                  FROM agent_transactions t
                  JOIN agent_entries e ON e.transaction_id = t.id AND e.account_id = %s AND e.own_account
                 WHERE t.created_at >= %s AND t.created_at < %s
                 ORDER BY t.created_at DESC
                 LIMIT %s
                """,
                (account_id, from_, to, limit),
            ).fetchall()
            # Top-ups that have no entries (yet, or ever): pending and failed ones.
            waiting = conn.execute(
                """
                SELECT t.id, t.kind, t.status, t.note, t.created_at, t.posted_at, u.amount_paise
                  FROM agent_topups u
                  JOIN agent_transactions t ON t.id = u.transaction_id
                 WHERE u.account_id = %s AND u.status <> 'posted'
                   AND t.created_at >= %s AND t.created_at < %s
                 ORDER BY t.created_at DESC
                 LIMIT %s
                """,
                (account_id, from_, to, limit),
            ).fetchall()
            # The arithmetic, in SQL: what came in and went out during the period,
            # and what moved after it (to walk the current balance back to the
            # period's end). Pending top-ups have no entries and count for nothing.
            totals = conn.execute(
                """
                SELECT COALESCE(SUM(e.amount_paise) FILTER (WHERE e.direction = 'credit'
                           AND t.created_at >= %(f)s AND t.created_at < %(t)s), 0) AS total_in,
                       COALESCE(SUM(e.amount_paise) FILTER (WHERE e.direction = 'debit'
                           AND t.created_at >= %(f)s AND t.created_at < %(t)s), 0) AS total_out,
                       COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_paise ELSE -e.amount_paise END)
                           FILTER (WHERE t.created_at >= %(t)s), 0) AS net_after
                  FROM agent_entries e
                  JOIN agent_transactions t ON t.id = e.transaction_id
                 WHERE e.account_id = %(a)s AND e.own_account
                """,
                {"a": account_id, "f": from_, "t": to},
            ).fetchone()
        assert totals is not None
        total_in, total_out, net_after = int(totals["total_in"]), int(totals["total_out"]), int(totals["net_after"])
        closing = int(account["balance_paise"]) - net_after
        opening = closing - (total_in - total_out)
        rows = [
            TransactionSummary(
                transaction_id=r["id"],
                kind=r["kind"],
                status=r["status"],
                note=_note(r["note"], include_notes),
                created_at=r["created_at"],
                posted_at=r["posted_at"],
                # a credit on my account is money IN, a debit is money OUT
                direction="in" if r["direction"] == "credit" else "out",
                amount_paise=r["amount_paise"],
                counterparty_account_id=r["counterparty_account_id"],
            )
            for r in moved
        ] + [
            TransactionSummary(
                transaction_id=r["id"],
                kind=r["kind"],
                status=r["status"],
                note=_note(r["note"], include_notes),
                created_at=r["created_at"],
                posted_at=r["posted_at"],
                direction=None,
                amount_paise=r["amount_paise"],
                counterparty_account_id=None,
            )
            for r in waiting
        ]
        rows.sort(key=lambda s: s.created_at, reverse=True)
        return TransactionsReport(
            account_id=account_id,
            period_from=from_,
            period_to=to,
            opening_balance_paise=opening,
            closing_balance_paise=closing,
            total_in_paise=total_in,
            total_out_paise=total_out,
            net_change_paise=total_in - total_out,
            transactions=rows[:limit],
        )

    def list_topups(self, ctx: ClientContext, from_: datetime, to: datetime) -> list[TopupItem]:
        """Every top-up onto any of the client's accounts in [from_, to), newest first, whatever its status."""
        with client_scope(self._pool, ctx) as conn:
            rows = conn.execute(
                """
                SELECT u.transaction_id, u.account_id, u.amount_paise, u.currency, u.status, t.created_at
                  FROM agent_topups u
                  JOIN agent_transactions t ON t.id = u.transaction_id
                 WHERE t.created_at >= %s AND t.created_at < %s
                 ORDER BY t.created_at DESC
                 LIMIT %s
                """,
                (from_, to, MAX_LIMIT),
            ).fetchall()
        return [
            TopupItem(
                transaction_id=r["transaction_id"],
                account_id=r["account_id"],
                amount_paise=r["amount_paise"],
                currency=r["currency"],
                status=r["status"],
                created_at=r["created_at"],
            )
            for r in rows
        ]

    def explain_transaction(
        self, ctx: ClientContext, transaction_id: UUID, include_notes: bool = False
    ) -> TransactionDetail:
        with client_scope(self._pool, ctx) as conn:
            tx = conn.execute(
                "SELECT id, kind, status, note, created_at, posted_at FROM agent_transactions WHERE id = %s",
                (transaction_id,),
            ).fetchone()
            if tx is None:
                raise NotFoundError(f"transaction {transaction_id} not found")
            legs = conn.execute(
                """
                SELECT account_id, direction, amount_paise, currency, own_account
                  FROM agent_entries WHERE transaction_id = %s
                 ORDER BY own_account DESC, direction
                """,
                (transaction_id,),
            ).fetchall()
            topup = conn.execute(
                "SELECT account_id, amount_paise, currency, status FROM agent_topups WHERE transaction_id = %s",
                (transaction_id,),
            ).fetchone()
        return TransactionDetail(
            transaction_id=tx["id"],
            kind=tx["kind"],
            status=tx["status"],
            note=_note(tx["note"], include_notes),
            created_at=tx["created_at"],
            posted_at=tx["posted_at"],
            legs=[
                Leg(
                    account_id=r["account_id"],
                    direction=r["direction"],
                    amount_paise=r["amount_paise"],
                    currency=r["currency"],
                    own_account=r["own_account"],
                )
                for r in legs
            ],
            topup=None
            if topup is None
            else TopupStatus(
                account_id=topup["account_id"],
                amount_paise=topup["amount_paise"],
                currency=topup["currency"],
                status=topup["status"],
            ),
        )
