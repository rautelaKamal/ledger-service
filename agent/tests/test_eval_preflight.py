"""The eval's preflight: it refuses to spend quota on a ledger that is not the seed, or on
policy chunks embedded with another model than the one the assistant searches with."""

import shutil
from pathlib import Path

import psycopg
from psycopg.rows import DictRow

from eval.preflight import POLICIES_DIR, check_policies, preflight
from eval.seed import ACCOUNTS, check_seed, seed
from ledger_agent.rag import load_policy_chunks


def test_the_seed_is_checked_by_content_not_by_a_marker(owner: psycopg.Connection[DictRow]) -> None:
    seed(owner)
    assert check_seed(owner) == []
    account = next(iter(ACCOUNTS.values()))
    with owner.transaction(force_rollback=True):
        owner.execute("UPDATE accounts SET balance_paise = balance_paise + 1 WHERE id = %s", (account.id,))
        problems = check_seed(owner)
    assert len(problems) == 1
    assert problems[0].startswith(f"eval account {account.key}: ")
    assert check_seed(owner) == []  # rolled back


def test_policy_chunks_must_use_the_configured_embedding_model(
    owner: psycopg.Connection[DictRow], ingested: None
) -> None:
    n = len(load_policy_chunks(POLICIES_DIR))
    assert check_policies(owner, "fake-768") == []
    problems = check_policies(owner, "gemini-embedding-2")
    assert problems == [
        f"policy chunks embedded with another model ({n} with fake-768), not gemini-embedding-2: "
        "re-ingest with scripts/ingest_policies.py"
    ]


def test_policy_chunks_must_match_the_policy_files(
    owner: psycopg.Connection[DictRow], ingested: None, tmp_path: Path
) -> None:
    one = sorted(POLICIES_DIR.glob("*.md"))[0]
    shutil.copy(one, tmp_path / one.name)
    fewer = len(load_policy_chunks(tmp_path))
    total = len(load_policy_chunks(POLICIES_DIR))
    problems = check_policies(owner, "fake-768", tmp_path)
    assert problems == [
        f"policy_chunks holds {total} chunks, the policy files make {fewer} "
        f"(0 missing, {total - fewer} not in the files)"
    ]


def test_preflight_is_both_checks(owner: psycopg.Connection[DictRow], ingested: None) -> None:
    seed(owner)
    assert preflight(owner, "fake-768") == []
    assert len(preflight(owner, "gemini-embedding-2")) == 1
