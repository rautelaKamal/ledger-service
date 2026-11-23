"""Before any model call: is the eval about to measure what it claims to?

1. The eval ledger is exactly the seed (eval.seed.check_seed), not merely "seeded once".
2. Every policy chunk is embedded with the model the assistant will search with, and the
   chunks are exactly the ones the policy files make. On 18 Nov 2026 a local test run
   replaced the real embeddings with fake ones, and every policy question failed for
   three days without anything saying so.
"""

from collections import Counter
from pathlib import Path

import psycopg
from psycopg.rows import DictRow

from ledger_agent.rag import load_policy_chunks

from .seed import check_seed

POLICIES_DIR = Path(__file__).resolve().parents[1] / "policies"


def check_policies(
    owner: psycopg.Connection[DictRow], embedding_model: str, policies_dir: Path = POLICIES_DIR
) -> list[str]:
    wanted = {c.content_hash for c in load_policy_chunks(policies_dir)}
    rows = owner.execute("SELECT content_hash, embedding_model FROM policy_chunks").fetchall()
    problems: list[str] = []
    wrong = Counter(r["embedding_model"] for r in rows if r["embedding_model"] != embedding_model)
    if wrong:
        found = ", ".join(f"{n} with {m}" for m, n in sorted(wrong.items()))
        problems.append(
            f"policy chunks embedded with another model ({found}), not {embedding_model}: "
            "re-ingest with scripts/ingest_policies.py"
        )
    have = {r["content_hash"] for r in rows}
    if len(rows) != len(wanted) or have != wanted:
        problems.append(
            f"policy_chunks holds {len(rows)} chunks, the policy files make {len(wanted)} "
            f"({len(wanted - have)} missing, {len(have - wanted)} not in the files)"
        )
    return problems


def preflight(owner: psycopg.Connection[DictRow], embedding_model: str) -> list[str]:
    return check_seed(owner) + check_policies(owner, embedding_model)
