"""HTTP: the probes, and POST /ask."""

import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import psycopg
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from langchain_core.embeddings import Embeddings
from langchain_core.language_models import BaseChatModel
from psycopg.rows import DictRow
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict, Field

from .config import REQUIRED_MIGRATIONS, Settings, apply_tracing_env, load_settings
from .dates import now_utc
from .db import ClientContext, create_pool
from .llm import UpstreamModelError, build_chat_model, build_embeddings
from .metrics import AgentMetrics
from .notes import CitedNote
from .prompts import FALLBACK_TEXT, MODEL_BUSY_TEXT, REFUSAL_TEXT
from .runs import RateLimitedError
from .service import Assistant
from .verify import Citation

log = logging.getLogger("ledger_agent")


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=2000)


class AskResponse(BaseModel):
    answer: str
    citations: list[Citation]
    verified: bool
    run_id: int
    # Cited transactions' notes, read from the ledger by code, for the client to see as quoted user text.
    notes: list[CitedNote]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    injected: Settings | None = getattr(app.state, "settings", None)
    if injected is None:
        # A real start: agent/.env may switch tracing on. When settings are
        # injected (tests), the env file is never read, so a developer's
        # LangSmith key can never make a test run send traces.
        apply_tracing_env()
    settings: Settings = injected or load_settings()
    pool = create_pool(settings.database_url, settings.pool_size)
    app.state.settings = settings
    app.state.pool = pool
    chat: BaseChatModel | None = getattr(app.state, "chat", None)
    embeddings: Embeddings | None = getattr(app.state, "embeddings", None)
    now_fn: Callable[[], datetime] = getattr(app.state, "now_fn", None) or now_utc
    if chat is None or embeddings is None:
        if settings.google_api_key:
            chat, embeddings = build_chat_model(settings), build_embeddings(settings)
        else:
            log.warning("GOOGLE_API_KEY is not set: /ask will answer 503 until it is")
    app.state.assistant = Assistant(pool, settings, chat, embeddings, now_fn) if chat and embeddings else None
    log.info("tracing: %s", "on (LangSmith)" if _tracing_enabled() else "off")
    if settings.metrics_port and not getattr(app.state, "metrics_serving", False):
        app.state.metrics.serve(settings.metrics_port)  # internal port only; never on 8000
        app.state.metrics_serving = True
        log.info("metrics on :%d", settings.metrics_port)
    try:
        yield
    finally:
        pool.close()


def _tracing_enabled() -> bool:
    from langsmith.utils import tracing_is_enabled

    return bool(tracing_is_enabled())


def create_app(
    settings: Settings | None = None,
    chat: BaseChatModel | None = None,
    embeddings: Embeddings | None = None,
    now_fn: Callable[[], datetime] | None = None,
) -> FastAPI:
    app = FastAPI(title="ledger-agent", lifespan=lifespan)
    app.state.metrics = AgentMetrics()
    if settings is not None:
        app.state.settings = settings
    if chat is not None:
        app.state.chat = chat
    if embeddings is not None:
        app.state.embeddings = embeddings
    if now_fn is not None:
        app.state.now_fn = now_fn

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        # Alive: the process answers. No dependencies on purpose (see step 6a).
        return {"status": "alive"}

    @app.get("/readyz")
    def readyz(request: Request) -> JSONResponse:
        # Ready: the database answers AS ledger_agent, and the migrations that
        # create the views, policies and tables are applied.
        pool: ConnectionPool[psycopg.Connection[DictRow]] = request.app.state.pool
        checks: dict[str, Any] = {"database": "down", "migrations": "unknown"}
        try:
            with pool.connection() as conn:
                checks["database"] = "up"
                rows = conn.execute(
                    "SELECT filename FROM schema_migrations WHERE filename = ANY(%s)", (list(REQUIRED_MIGRATIONS),)
                ).fetchall()
                applied = {r["filename"] for r in rows}
                checks["migrations"] = "applied" if applied == set(REQUIRED_MIGRATIONS) else "pending"
        except psycopg.Error:
            pass
        ready = checks["database"] == "up" and checks["migrations"] == "applied"
        return JSONResponse(status_code=200 if ready else 503, content={"ready": ready, "checks": checks})

    @app.post("/ask", response_model=AskResponse)
    def ask(request: Request, body: AskRequest, x_client_id: str | None = Header(default=None)) -> JSONResponse:
        metrics: AgentMetrics = request.app.state.metrics
        # The client id comes from the header and nowhere else (the auth stand-in).
        try:
            ctx = ClientContext.from_header(x_client_id)
        except ValueError as e:
            metrics.not_answered("bad_request")
            return JSONResponse(status_code=400, content={"error": {"code": "missing_client_id", "message": str(e)}})
        assistant: Assistant | None = request.app.state.assistant
        if assistant is None:
            metrics.not_answered("upstream_failed")
            return JSONResponse(
                status_code=503, content={"error": {"code": "model_not_configured", "message": MODEL_BUSY_TEXT}}
            )
        started = time.perf_counter()
        try:
            result = assistant.ask(ctx, body.question)
        except RateLimitedError as e:
            metrics.not_answered("rate_limited")
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": "3600"},
                content={"error": {"code": "rate_limited", "message": f"at most {e.limit} questions per 24 hours"}},
            )
        except UpstreamModelError as e:
            # Logged, not recorded: an upstream failure is not a question the client asked.
            log.warning("upstream model failure for client %s (quota: %s): %s", ctx.client_id, e.quota, e)
            if e.quota:
                # Its own code, so the web app can say "over today's free limit" and show a
                # labelled scripted answer instead of pretending the assistant is just busy.
                metrics.not_answered("upstream_quota")
                return JSONResponse(
                    status_code=503,
                    headers={"Retry-After": "60"},
                    content={"error": {"code": "model_quota", "message": MODEL_BUSY_TEXT}},
                )
            metrics.not_answered("upstream_failed")
            return JSONResponse(
                status_code=503,
                headers={"Retry-After": "30"},
                content={"error": {"code": "model_unavailable", "message": MODEL_BUSY_TEXT}},
            )
        # Where the time went, per question (step 7g). No question or answer text: only counts and seconds.
        log.info(
            "answered run=%s category=%s verified=%s attempts=%d chat_calls=%d embed_calls=%d tool_calls=%d "
            "total_s=%.2f model_s=%.2f tool_s=%.2f steps=%s",
            result.run_id,
            result.category,
            result.verified,
            result.attempts,
            result.chat_calls,
            result.embed_calls,
            len(result.tools),
            result.latency_s,
            result.model_s,
            result.tool_s,
            " ".join(f"{name}:{seconds:.2f}" for name, seconds in result.steps_s),
        )
        metrics.answered(result, REFUSAL_TEXT, FALLBACK_TEXT, time.perf_counter() - started)
        return JSONResponse(
            status_code=200,
            content=AskResponse(
                answer=result.answer,
                citations=result.citations,
                verified=result.verified,
                run_id=result.run_id,
                notes=list(result.notes),
            ).model_dump(mode="json"),
        )

    return app


app = create_app()
