"""One question, end to end: rate limit, the graph, the audit row."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from time import perf_counter

import psycopg
from langchain_core.embeddings import Embeddings
from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import RunnableConfig
from psycopg.rows import DictRow
from psycopg_pool import ConnectionPool

from .config import Settings
from .dates import now_utc
from .db import ClientContext, client_scope
from .graph import Deps, run_question
from .runs import RATE_WINDOW, RateLimitedError, RunRecord, insert_run, questions_in_window
from .tools import LedgerTools
from .verify import Citation


@dataclass(frozen=True)
class AskResult:
    run_id: int
    answer: str
    citations: list[Citation]
    verified: bool
    # For metrics (step 7c); not part of the HTTP response.
    category: str = ""
    chat_calls: int = 0
    embed_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    tools: tuple[tuple[str, bool], ...] = ()


class Assistant:
    def __init__(
        self,
        pool: ConnectionPool[psycopg.Connection[DictRow]],
        settings: Settings,
        chat: BaseChatModel,
        embeddings: Embeddings,
        now_fn: Callable[[], datetime] = now_utc,
        ledger: LedgerTools | None = None,
    ) -> None:
        self._pool = pool
        self._settings = settings
        self._chat = chat
        self._embeddings = embeddings
        self._now = now_fn
        # Injectable so the eval can time the tools; always the same read-only tools.
        self._ledger = ledger or LedgerTools(pool)

    def ask(self, ctx: ClientContext, question: str, trace: RunnableConfig | None = None) -> AskResult:
        # 1. The cap, BEFORE any model call: a client over the limit costs nothing upstream.
        with client_scope(self._pool, ctx) as conn:
            asked = questions_in_window(conn)
        if asked >= self._settings.daily_limit:
            raise RateLimitedError(self._settings.daily_limit, RATE_WINDOW)

        # 2. The graph. A provider failure raises UpstreamModelError out of here:
        #    no agent_runs row, so it does not count toward the cap either.
        started = perf_counter()
        outcome = run_question(
            Deps(
                chat=self._chat,
                embeddings=self._embeddings,
                ledger=self._ledger,
                pool=self._pool,
                ctx=ctx,
                now=self._now(),
                features=self._settings.features,
            ),
            question,
            trace,
        )
        latency_ms = int((perf_counter() - started) * 1000)

        # 3. The audit row, inside a client scope (RLS: only this client's id is accepted),
        #    verified or not: a failed verification is exactly what the log is for.
        record = RunRecord(
            question=question,
            category=outcome.category,
            answer=outcome.answer,
            verified=outcome.verified,
            attempts=outcome.attempts,
            model=self._settings.model,
            latency_ms=latency_ms,
            tools_called=[{"name": c.name, "args": c.args, "ok": c.ok} for c in outcome.tools_called],
            retrieved_chunk_ids=outcome.retrieved_ids,
            citations=[{"type": c.type, "id": c.id} for c in outcome.citations],
            verify_failures=outcome.failures,
            prompt_tokens=outcome.usage.prompt_tokens,
            completion_tokens=outcome.usage.completion_tokens,
        )
        with client_scope(self._pool, ctx, read_only=False) as conn:
            run_id = insert_run(conn, ctx.client_id, record)
        return AskResult(
            run_id=run_id,
            answer=outcome.answer,
            citations=outcome.citations,
            verified=outcome.verified,
            category=outcome.category,
            chat_calls=outcome.usage.chat_calls,
            embed_calls=outcome.usage.embed_calls,
            prompt_tokens=outcome.usage.prompt_tokens,
            completion_tokens=outcome.usage.completion_tokens,
            tools=tuple((c.name, c.ok) for c in outcome.tools_called),
        )
