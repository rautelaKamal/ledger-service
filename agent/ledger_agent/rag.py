"""Policy documents: chunking, ingestion, and nearest-neighbour search.

A policy document is a Markdown file in agent/policies/. Each `## heading` is
one chunk. A chunk's identity is the sha256 of (file, heading, content), so
ingestion can tell "unchanged", "changed" and "removed" apart without a model
call: only new or changed chunks are embedded, which is what keeps repeated
runs free. The embedding model's name is stored with each row; changing the
model changes every hash's meaning, so the ingestion treats that as "changed".
"""

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

import psycopg
from langchain_core.embeddings import Embeddings
from psycopg.rows import DictRow

TOP_K = 3
HEADING_RE = re.compile(r"^## +(.+?)\s*$", re.MULTILINE)
TITLE_RE = re.compile(r"^# +(.+?)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class Chunk:
    source_file: str
    heading: str
    content: str

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(f"{self.source_file}\n{self.heading}\n{self.content}".encode()).hexdigest()


@dataclass(frozen=True)
class RetrievedChunk:
    id: int
    source_file: str
    heading: str
    content: str


@dataclass(frozen=True)
class SyncResult:
    inserted: int
    deleted: int
    kept: int


def chunk_markdown(source_file: str, text: str) -> list[Chunk]:
    """One chunk per '## heading'; the text before the first one is dropped (title and banner)."""
    title_match = TITLE_RE.search(text)
    title = title_match.group(1) if title_match else source_file
    chunks: list[Chunk] = []
    matches = list(HEADING_RE.finditer(text))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[m.end() : end].strip()
        if body:
            chunks.append(Chunk(source_file=source_file, heading=f"{title}: {m.group(1).strip()}", content=body))
    return chunks


def load_policy_chunks(policies_dir: Path) -> list[Chunk]:
    chunks: list[Chunk] = []
    for path in sorted(policies_dir.glob("*.md")):
        chunks.extend(chunk_markdown(path.name, path.read_text()))
    return chunks


# gemini-embedding-2 takes the task as text, not as a parameter: documents and
# queries are formatted differently, and consistently (ai.google.dev/gemini-api/docs/embeddings).
def document_text(chunk: Chunk) -> str:
    return f"title: {chunk.heading} | text: {chunk.content}"


def query_text(question: str) -> str:
    return f"task: question answering | query: {question}"


def vector_literal(values: list[float]) -> str:
    """pgvector's text form, '[0.1,0.2,...]', so no extra adapter library is needed."""
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


def sync_policies(
    owner: psycopg.Connection[DictRow],
    embeddings: Embeddings,
    policies_dir: Path,
    embedding_model: str,
    dry_run: bool = False,
) -> SyncResult:
    """Make policy_chunks match the files: insert new/changed chunks (embedding them), delete removed ones."""
    wanted = {c.content_hash: c for c in load_policy_chunks(policies_dir)}
    existing = {
        r["content_hash"]: r["embedding_model"]
        for r in owner.execute("SELECT content_hash, embedding_model FROM policy_chunks").fetchall()
    }
    to_insert = [c for h, c in wanted.items() if existing.get(h) != embedding_model]
    to_delete = [h for h, model in existing.items() if h not in wanted or model != embedding_model]
    kept = len(wanted) - len(to_insert)
    if dry_run:
        return SyncResult(inserted=len(to_insert), deleted=len(to_delete), kept=kept)

    vectors = embeddings.embed_documents([document_text(c) for c in to_insert]) if to_insert else []
    with owner.transaction():
        if to_delete:
            owner.execute("DELETE FROM policy_chunks WHERE content_hash = ANY(%s)", (to_delete,))
        for chunk, vector in zip(to_insert, vectors, strict=True):
            owner.execute(
                """INSERT INTO policy_chunks (source_file, heading, content, content_hash, embedding, embedding_model)
                   VALUES (%s, %s, %s, %s, %s::vector, %s)""",
                (
                    chunk.source_file,
                    chunk.heading,
                    chunk.content,
                    chunk.content_hash,
                    vector_literal(vector),
                    embedding_model,
                ),
            )
    return SyncResult(inserted=len(to_insert), deleted=len(to_delete), kept=kept)


def search(conn: psycopg.Connection[DictRow], query_vector: list[float], k: int = TOP_K) -> list[RetrievedChunk]:
    """The k nearest chunks by cosine distance (the HNSW index on policy_chunks.embedding)."""
    rows = conn.execute(
        """SELECT id, source_file, heading, content
             FROM policy_chunks
            ORDER BY embedding <=> %s::vector
            LIMIT %s""",
        (vector_literal(query_vector), k),
    ).fetchall()
    return [
        RetrievedChunk(id=r["id"], source_file=r["source_file"], heading=r["heading"], content=r["content"])
        for r in rows
    ]
