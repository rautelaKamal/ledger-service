"""Ingest agent/policies/*.md into policy_chunks, as ledger_owner. Idempotent.

    uv run python scripts/ingest_policies.py            # embed new/changed chunks, delete removed ones
    uv run python scripts/ingest_policies.py --dry-run  # only say what would change

Needs OWNER_DATABASE_URL and GOOGLE_API_KEY (agent/.env or the environment).
Unchanged chunks cost nothing: they are matched by content hash and skipped.
"""

import argparse
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ledger_agent.config import load_settings
from ledger_agent.llm import build_embeddings
from ledger_agent.rag import sync_policies

POLICIES_DIR = Path(__file__).resolve().parents[1] / "policies"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="report what would change; embed and write nothing")
    args = parser.parse_args()

    settings = load_settings()
    if not settings.owner_database_url:
        print("OWNER_DATABASE_URL is not set", file=sys.stderr)
        return 1
    embeddings = build_embeddings(settings)
    with psycopg.connect(settings.owner_database_url, row_factory=dict_row) as owner:
        result = sync_policies(owner, embeddings, POLICIES_DIR, settings.embedding_model, dry_run=args.dry_run)
    verb = "would insert" if args.dry_run else "inserted"
    deleted = "would delete" if args.dry_run else "deleted"
    print(
        f"{verb} {result.inserted}, {deleted} {result.deleted}, kept {result.kept} chunks ({settings.embedding_model})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
