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
        assert ready.json() == {"ready": True, "checks": {"database": "up", "migration": "applied"}}


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
