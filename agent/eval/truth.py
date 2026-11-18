"""Ground truth, computed with plain SQL as ledger_owner, independently of the assistant's tools.

Nothing here reads cached balances or calls LedgerTools: balances are summed
from posted entries, periods are whole India-time days, top-ups are read from
the topups table. If the tools and these functions disagree, one of them is
wrong, and the eval says so.
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import DictRow

from .seed import ACCOUNTS, TX

IST = ZoneInfo("Asia/Kolkata")


def _ist_start(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=IST)


@dataclass(frozen=True)
class Period:
    total_in: int
    total_out: int
    net: int
    opening: int
    closing: int


class Truth:
    def __init__(self, owner: psycopg.Connection[DictRow]) -> None:
        self.db = owner

    def _one(self, sql: str, args: tuple[object, ...]) -> int:
        row = self.db.execute(sql, args).fetchone()
        assert row is not None
        return int(next(iter(row.values())) or 0)

    def balance(self, account: str) -> int:
        """Credits minus debits of every posted entry on the account."""
        return self._one(
            """SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_paise ELSE -e.amount_paise END), 0)
                 FROM entries e JOIN transactions t ON t.id = e.transaction_id
                WHERE e.account_id = %s AND t.status = 'posted'""",
            (ACCOUNTS[account].id,),
        )

    def balance_at(self, account: str, moment: datetime) -> int:
        return self._one(
            """SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_paise ELSE -e.amount_paise END), 0)
                 FROM entries e JOIN transactions t ON t.id = e.transaction_id
                WHERE e.account_id = %s AND t.status = 'posted' AND t.created_at < %s""",
            (ACCOUNTS[account].id, moment),
        )

    def amount(self, tx: str) -> int:
        """A transaction's amount: its entries if posted, else what the top-up asked for."""
        return self._one(
            """SELECT COALESCE((SELECT max(amount_paise) FROM entries WHERE transaction_id = %s),
                               (SELECT amount_paise FROM topups WHERE transaction_id = %s))""",
            (TX[tx].id, TX[tx].id),
        )

    def status(self, tx: str) -> str:
        row = self.db.execute("SELECT status FROM transactions WHERE id = %s", (TX[tx].id,)).fetchone()
        assert row is not None
        return str(row["status"])

    def period(self, account: str, first: date, last: date) -> Period:
        """Whole India-time days first..last inclusive, as the tools define a period."""
        start, end = _ist_start(first), _ist_start(last + timedelta(days=1))
        acct = ACCOUNTS[account].id
        sql = """SELECT COALESCE(SUM(e.amount_paise), 0) FROM entries e JOIN transactions t ON t.id = e.transaction_id
                  WHERE e.account_id = %s AND t.status = 'posted' AND e.direction = %s
                    AND t.created_at >= %s AND t.created_at < %s"""
        total_in = self._one(sql, (acct, "credit", start, end))
        total_out = self._one(sql, (acct, "debit", start, end))
        opening = self.balance_at(account, start)
        return Period(total_in, total_out, total_in - total_out, opening, opening + total_in - total_out)

    def topups(self, client: str, first: date, last: date) -> list[tuple[uuid.UUID, int, str]]:
        """(transaction id, amount, status) of every top-up onto the client's accounts in the period."""
        start, end = _ist_start(first), _ist_start(last + timedelta(days=1))
        rows = self.db.execute(
            """SELECT u.transaction_id, u.amount_paise, t.status
                 FROM topups u JOIN transactions t ON t.id = u.transaction_id
                 JOIN accounts a ON a.id = u.account_id
                WHERE a.owner_client_id = %s AND t.created_at >= %s AND t.created_at < %s
                ORDER BY t.created_at""",
            (client, start, end),
        ).fetchall()
        return [(uuid.UUID(str(r["transaction_id"])), int(r["amount_paise"]), str(r["status"])) for r in rows]

    def chunk_ids(self, source_file: str, heading_contains: str) -> set[int]:
        rows = self.db.execute(
            "SELECT id FROM policy_chunks WHERE source_file = %s AND heading ILIKE %s",
            (source_file, f"%{heading_contains}%"),
        ).fetchall()
        return {int(r["id"]) for r in rows}
