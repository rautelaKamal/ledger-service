"""agent_runs: the audit log, and the rate limit that is counted from it.

Both run inside a client_scope, so row-level security does the scoping: the
count only sees this client's runs, and an INSERT with another client's id is
refused by Postgres (WITH CHECK), whatever the Python code passes.
"""

import json
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

import psycopg
from psycopg.rows import DictRow
from psycopg.types.json import Jsonb

RATE_WINDOW = timedelta(hours=24)


class RateLimitedError(Exception):
    def __init__(self, limit: int, window: timedelta) -> None:
        super().__init__(f"more than {limit} questions in {window}")
        self.limit = limit
        self.window = window


@dataclass
class RunRecord:
    question: str
    category: str
    answer: str
    verified: bool
    attempts: int
    model: str
    latency_ms: int
    tools_called: list[dict[str, Any]] = field(default_factory=list)
    retrieved_chunk_ids: list[int] = field(default_factory=list)
    citations: list[dict[str, str]] = field(default_factory=list)
    verify_failures: list[list[str]] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0


def questions_in_window(conn: psycopg.Connection[DictRow], window: timedelta = RATE_WINDOW) -> int:
    row = conn.execute(
        "SELECT count(*) AS n FROM agent_runs WHERE client_id = agent_client_id() AND created_at >= now() - %s",
        (window,),
    ).fetchone()
    assert row is not None
    return int(row["n"])


def insert_run(conn: psycopg.Connection[DictRow], client_id: str, record: RunRecord) -> int:
    row = conn.execute(
        """
        INSERT INTO agent_runs (client_id, question, category, tools_called, retrieved_chunk_ids, answer,
                                citations, verified, verify_failures, attempts, model, prompt_tokens,
                                completion_tokens, latency_ms)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            client_id,
            record.question,
            record.category,
            Jsonb(json.loads(json.dumps(record.tools_called, default=str))),
            record.retrieved_chunk_ids,
            record.answer,
            Jsonb(record.citations),
            record.verified,
            Jsonb(record.verify_failures),
            record.attempts,
            record.model,
            record.prompt_tokens,
            record.completion_tokens,
            record.latency_ms,
        ),
    ).fetchone()
    assert row is not None
    return int(row["id"])
