"""Configuration from environment variables, validated once at start-up."""

import os
from dataclasses import dataclass

# The migration this service needs: the views, the policies, the agent role's
# grants. /readyz says "not ready" until it is applied.
REQUIRED_MIGRATION = "008_account_ownership_and_agent_access.sql"


@dataclass(frozen=True)
class Settings:
    database_url: str
    port: int = 8000
    pool_size: int = 4


def load_settings(env: dict[str, str] | None = None) -> Settings:
    e = os.environ if env is None else env
    url = e.get("AGENT_DATABASE_URL", "")
    if not url.startswith("postgres://") and not url.startswith("postgresql://"):
        raise ValueError("AGENT_DATABASE_URL must be set to a postgres:// URL (the ledger_agent role)")
    port = int(e.get("PORT", "8000"))
    if not 0 < port < 65536:
        raise ValueError("PORT must be 1-65535")
    return Settings(database_url=url, port=port, pool_size=int(e.get("AGENT_POOL_SIZE", "4")))
