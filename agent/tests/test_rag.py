"""Chunking, idempotent ingestion, and nearest-neighbour search, with fake embeddings."""

from pathlib import Path

import psycopg
from psycopg.rows import DictRow
from psycopg_pool import ConnectionPool

from ledger_agent.db import ClientContext, client_scope
from ledger_agent.rag import chunk_markdown, query_text, search, sync_policies

from .fakes import FakeEmbeddings

POLICIES = Path(__file__).resolve().parents[1] / "policies"
FAKE_MODEL = "fake-768"


def test_chunk_markdown_one_chunk_per_heading_with_the_title() -> None:
    text = "# Fees\n\n> banner\n\n## Transfers\n\nFree.\n\n## Top-ups\n\n2% by card.\n\n## Empty\n\n"
    chunks = chunk_markdown("fees.md", text)
    assert [(c.heading, c.content) for c in chunks] == [("Fees: Transfers", "Free."), ("Fees: Top-ups", "2% by card.")]
    assert len({c.content_hash for c in chunks}) == 2
    assert chunk_markdown("fees.md", text)[0].content_hash == chunks[0].content_hash  # deterministic


def test_ingestion_is_idempotent_and_tracks_changes(owner: psycopg.Connection[DictRow], tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("# A\n\n## One\n\nalpha text\n\n## Two\n\nbeta text\n")
    (tmp_path / "b.md").write_text("# B\n\n## Three\n\ngamma text\n")
    emb = FakeEmbeddings()

    def count(where: str = "true") -> int:
        row = owner.execute(f"SELECT count(*) AS n FROM policy_chunks WHERE {where}").fetchone()
        assert row is not None
        return int(row["n"])

    # sync makes the WHOLE table match the folder, so this runs in a transaction
    # that is rolled back: the real policies the other tests search stay put.
    with owner.transaction(force_rollback=True):
        before = count()
        first = sync_policies(owner, emb, tmp_path, FAKE_MODEL)
        assert (first.inserted, first.deleted, first.kept) == (3, before, 0)
        again = sync_policies(owner, emb, tmp_path, FAKE_MODEL)
        assert (again.inserted, again.deleted, again.kept) == (0, 0, 3)

        # Change one chunk, remove one file: one re-embedded, two deleted, one kept.
        (tmp_path / "a.md").write_text("# A\n\n## One\n\nalpha text CHANGED\n\n## Two\n\nbeta text\n")
        (tmp_path / "b.md").unlink()
        dry = sync_policies(owner, emb, tmp_path, FAKE_MODEL, dry_run=True)
        assert (dry.inserted, dry.deleted, dry.kept) == (1, 2, 1)
        assert count() == 3  # a dry run writes nothing
        third = sync_policies(owner, emb, tmp_path, FAKE_MODEL)
        assert (third.inserted, third.deleted, third.kept) == (1, 2, 1)
        rows = owner.execute("SELECT heading, content FROM policy_chunks ORDER BY heading").fetchall()
        assert [(r["heading"], r["content"]) for r in rows] == [
            ("A: One", "alpha text CHANGED"),
            ("A: Two", "beta text"),
        ]
    assert count() == before


def test_search_finds_the_refund_policy(ingested: None, pool: ConnectionPool[psycopg.Connection[DictRow]]) -> None:
    ctx = ClientContext(client_id="anyone")
    vector = FakeEmbeddings().embed_query(query_text("how long do failed top-up refunds take?"))
    with client_scope(pool, ctx) as conn:
        hits = search(conn, vector)
    assert len(hits) == 3
    assert hits[0].source_file == "failed-top-up-refunds.md"
    assert "refund" in hits[0].content.lower()
