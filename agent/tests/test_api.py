"""The probes, against the real database."""

import pytest
from fastapi.testclient import TestClient

from ledger_agent.api import create_app
from ledger_agent.config import Settings, load_settings


def test_healthz_and_readyz(settings: Settings) -> None:
    with TestClient(create_app(settings)) as client:
        assert client.get("/healthz").json() == {"status": "alive"}
        ready = client.get("/readyz")
        assert ready.status_code == 200
        assert ready.json() == {"ready": True, "checks": {"database": "up", "migrations": "applied"}}


def test_readyz_is_503_when_the_database_is_unreachable() -> None:
    bad = Settings(database_url="postgres://ledger_agent:x@127.0.0.1:9/nowhere", pool_size=1)
    with TestClient(create_app(bad)) as client:
        assert client.get("/healthz").status_code == 200  # alive, not ready
        ready = client.get("/readyz")
        assert ready.status_code == 503
        assert ready.json()["checks"]["database"] == "down"


def test_settings_validation() -> None:
    assert load_settings({"AGENT_DATABASE_URL": "postgres://a:b@c/d", "PORT": "8080"}).port == 8080
    with pytest.raises(ValueError):
        load_settings({})
    with pytest.raises(ValueError):
        load_settings({"AGENT_DATABASE_URL": "postgres://a:b@c/d", "PORT": "0"})


def test_tracing_variables_are_exported_from_the_env_file_and_the_environment_wins(
    tmp_path: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pathlib import Path

    from langsmith.utils import tracing_is_enabled

    from ledger_agent.config import TRACING_VARS, apply_tracing_env

    for var in (*TRACING_VARS, "LANGCHAIN_TRACING_V2", "LANGCHAIN_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    env_file = Path(str(tmp_path)) / ".env"
    env_file.write_text(
        "GOOGLE_API_KEY=not-exported\nLANGSMITH_TRACING=true\nLANGSMITH_API_KEY=ls-test\nLANGSMITH_PROJECT=from-file\n"
    )
    monkeypatch.setenv("LANGSMITH_PROJECT", "from-environment")

    exported = apply_tracing_env(env_file)

    import os

    assert sorted(exported) == ["LANGSMITH_API_KEY", "LANGSMITH_TRACING"]
    assert os.environ["LANGSMITH_PROJECT"] == "from-environment"  # the real environment wins
    assert "GOOGLE_API_KEY" not in os.environ  # only tracing variables are exported
    assert tracing_is_enabled()
    for var in TRACING_VARS:
        monkeypatch.delenv(var, raising=False)
    from .conftest import clear_langsmith_env_cache

    clear_langsmith_env_cache()  # langsmith caches environment lookups
    assert apply_tracing_env(None) == []
    empty = Path(str(tmp_path)) / "empty.env"
    empty.write_text("GOOGLE_API_KEY=x\n")
    assert apply_tracing_env(empty) == []
    assert not tracing_is_enabled()
