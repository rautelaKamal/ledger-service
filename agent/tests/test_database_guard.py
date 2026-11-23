"""The agent tests refuse any database not named *_test (they write fake embeddings)."""

import pytest

from .conftest import require_test_database


def test_refuses_the_eval_database() -> None:
    refused = r"database 'ledger': the agent tests only run against a database named \*_test"
    with pytest.raises(RuntimeError, match=refused):
        require_test_database("OWNER_DATABASE_URL", "postgres://ledger_owner:x@localhost:5434/ledger")


def test_refuses_the_demo_and_e2e_databases() -> None:
    for db in ("ledger_demo", "ledger_e2e", "ledger_test_copy"):
        with pytest.raises(RuntimeError):
            require_test_database("AGENT_DATABASE_URL", f"postgres://ledger_agent:x@localhost:5434/{db}")


def test_accepts_a_test_database() -> None:
    url = "postgres://ledger_owner:x@localhost:5432/ledger_test"
    assert require_test_database("OWNER_DATABASE_URL", url) == url
