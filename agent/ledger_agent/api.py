"""HTTP: the probes Kubernetes and Compose ask for. The assistant's own endpoints come in step 7b."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from psycopg.rows import DictRow
from psycopg_pool import ConnectionPool

from .config import REQUIRED_MIGRATION, Settings, load_settings
from .db import create_pool
from .tools import LedgerTools


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = getattr(app.state, "settings", None) or load_settings()
    pool = create_pool(settings.database_url, settings.pool_size)
    app.state.settings = settings
    app.state.pool = pool
    app.state.tools = LedgerTools(pool)
    try:
        yield
    finally:
        pool.close()


def create_app(settings: Settings | None = None) -> FastAPI:
    app = FastAPI(title="ledger-agent", lifespan=lifespan)
    if settings is not None:
        app.state.settings = settings

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        # Alive: the process answers. No dependencies on purpose (see step 6a).
        return {"status": "alive"}

    @app.get("/readyz")
    def readyz(request: Request) -> JSONResponse:
        # Ready: the database answers AS ledger_agent, and the migration that
        # creates the views and policies is applied.
        pool: ConnectionPool[psycopg.Connection[DictRow]] = request.app.state.pool
        checks: dict[str, Any] = {"database": "down", "migration": "unknown"}
        try:
            with pool.connection() as conn:
                checks["database"] = "up"
                row = conn.execute(
                    "SELECT 1 FROM schema_migrations WHERE filename = %s", (REQUIRED_MIGRATION,)
                ).fetchone()
                checks["migration"] = "applied" if row else "pending"
        except psycopg.Error:
            pass
        ready = checks["database"] == "up" and checks["migration"] == "applied"
        return JSONResponse(status_code=200 if ready else 503, content={"ready": ready, "checks": checks})

    return app


app = create_app()
