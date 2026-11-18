"""The three tools against the real database, as ledger_agent, through row-level security."""

import inspect
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from ledger_agent.db import ClientContext
from ledger_agent.tools import LedgerTools, NotFoundError

from .conftest import Seed


def test_get_balance_returns_the_clients_account_as_integer_paise(tools: LedgerTools, seed: Seed) -> None:
    ctx = seed.client()
    acct = seed.account(ctx, "main")
    # Above 2**53: a float would round this. Python ints and Postgres BIGINT do not.
    huge = 9_007_199_254_740_993
    seed.posted("topup", seed.settlement(), acct, huge)

    balance = tools.get_balance(ctx, acct)

    assert balance.account_id == acct
    assert balance.name == "main"
    assert balance.currency == "INR"
    assert balance.balance_paise == huge
    assert type(balance.balance_paise) is int
    assert balance.as_of.tzinfo is not None


def test_another_clients_account_is_not_found_just_like_a_missing_one(tools: LedgerTools, seed: Seed) -> None:
    mine, theirs = seed.client(), seed.client()
    their_acct = seed.account(theirs, "theirs")
    seed.posted("topup", seed.settlement(), their_acct, 500)

    with pytest.raises(NotFoundError):
        tools.get_balance(mine, their_acct)
    with pytest.raises(NotFoundError):
        tools.get_balance(mine, uuid.uuid4())
    with pytest.raises(NotFoundError):
        tools.list_transactions(mine, their_acct)
    # The owner, of course, sees it.
    assert tools.get_balance(theirs, their_acct).balance_paise == 500


def test_list_transactions_shows_direction_counterparty_window_and_pending_topups(
    tools: LedgerTools, seed: Seed
) -> None:
    ctx, other = seed.client(), seed.client()
    acct = seed.account(ctx, "main")
    payee = seed.account(other, "payee")
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    funded = seed.posted("topup", seed.settlement(), acct, 10_000, created_at=t0)
    paid = seed.posted("transfer", acct, payee, 2_500, note="rent", created_at=t0 + timedelta(days=1))
    received = seed.posted("transfer", payee, acct, 100, created_at=t0 + timedelta(days=2))
    waiting = seed.pending_topup(acct, 700)
    # Something that is not this account's business at all.
    seed.posted("transfer", payee, seed.account(other, "spare"), 1, created_at=t0 + timedelta(days=1))

    rows = tools.list_transactions(ctx, acct).transactions

    assert [r.transaction_id for r in rows] == [waiting, received, paid, funded]  # newest first
    by_id = {r.transaction_id: r for r in rows}
    assert (by_id[paid].direction, by_id[paid].amount_paise, by_id[paid].counterparty_account_id) == (
        "out",
        2_500,
        payee,
    )
    assert (by_id[received].direction, by_id[received].amount_paise, by_id[received].counterparty_account_id) == (
        "in",
        100,
        payee,
    )
    assert by_id[paid].note == "rent"
    assert (by_id[waiting].status, by_id[waiting].direction, by_id[waiting].amount_paise) == ("pending", None, 700)
    assert all(type(r.amount_paise) is int for r in rows)

    # The window is [from, to).
    report = tools.list_transactions(ctx, acct, from_=t0 + timedelta(days=1), to=t0 + timedelta(days=2))
    assert [r.transaction_id for r in report.transactions] == [paid]
    assert (report.total_in_paise, report.total_out_paise, report.net_change_paise) == (0, 2_500, -2_500)
    assert (report.opening_balance_paise, report.closing_balance_paise) == (10_000, 7_500)
    assert [r.transaction_id for r in tools.list_transactions(ctx, acct, limit=1).transactions] == [waiting]

    # The payee sees the same transfers from their side: in and out swap.
    theirs = {r.transaction_id: r for r in tools.list_transactions(other, payee).transactions}
    assert theirs[paid].direction == "in" and theirs[paid].counterparty_account_id == acct
    assert theirs[received].direction == "out"
    assert funded not in theirs and waiting not in theirs


def test_explain_transaction_shows_every_leg_and_which_are_mine(tools: LedgerTools, seed: Seed) -> None:
    ctx, other = seed.client(), seed.client()
    acct = seed.account(ctx, "main")
    payee = seed.account(other, "payee")
    seed.posted("topup", seed.settlement(), acct, 1_000)
    tx = seed.posted("transfer", acct, payee, 400, note="lunch")

    detail = tools.explain_transaction(ctx, tx)

    assert detail.kind == "transfer" and detail.status == "posted" and detail.note == "lunch"
    assert detail.posted_at is not None and detail.topup is None
    assert [(leg.account_id, leg.direction, leg.amount_paise, leg.own_account) for leg in detail.legs] == [
        (acct, "debit", 400, True),
        (payee, "credit", 400, False),
    ]
    # The counterparty sees the same two legs, flipped.
    flipped = tools.explain_transaction(other, tx)
    assert {(leg.account_id, leg.own_account) for leg in flipped.legs} == {(acct, False), (payee, True)}
    # A third client sees nothing of it.
    with pytest.raises(NotFoundError):
        tools.explain_transaction(seed.client(), tx)

    topup = seed.pending_topup(acct, 250)
    explained = tools.explain_transaction(ctx, topup)
    assert explained.legs == [] and explained.status == "pending"
    assert explained.topup is not None
    assert (explained.topup.account_id, explained.topup.amount_paise, explained.topup.status) == (acct, 250, "pending")


def test_the_client_id_is_never_a_tool_argument() -> None:
    """A model fills in tool arguments; the client id must not be one of them."""
    for name, fn in inspect.getmembers(LedgerTools, inspect.isfunction):
        if name.startswith("_"):
            continue
        params = list(inspect.signature(fn).parameters)
        assert params[:2] == ["self", "ctx"], name
        assert not any("client" in p for p in params[2:]), name
        assert inspect.signature(fn).parameters["ctx"].annotation is ClientContext, name


def test_a_hostile_client_id_is_plain_data(tools: LedgerTools, seed: Seed) -> None:
    victim = seed.client()
    acct = seed.account(victim, "victim")
    seed.posted("topup", seed.settlement(), acct, 999)
    for hostile in (
        "'; RESET ROLE; SET ROLE ledger_owner; --",
        f"{victim.client_id}' OR '1'='1",
        '"; DROP TABLE accounts; --',
        f"{victim.client_id}\n; SELECT 1",
    ):
        with pytest.raises(NotFoundError):
            tools.get_balance(ClientContext(client_id=hostile), acct)
    # ... and a client whose id really is that string is simply a client.
    weird = ClientContext(client_id="'; RESET ROLE; --")
    weird_acct = seed.account(weird, "weird")
    assert tools.get_balance(weird, weird_acct).balance_paise == 0


def test_client_context_requires_a_sane_header() -> None:
    assert ClientContext.from_header("alice").client_id == "alice"
    for bad in (None, "", "x" * 256):
        with pytest.raises(ValueError):
            ClientContext.from_header(bad)
