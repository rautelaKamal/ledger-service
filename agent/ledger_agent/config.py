"""Configuration from environment variables, validated once at start-up."""

import os
from dataclasses import dataclass
from pathlib import Path

# The migrations this service needs: 008 for the views and policies, 009 for
# policy_chunks and agent_runs. /readyz says "not ready" until both are applied.
REQUIRED_MIGRATIONS = (
    "008_account_ownership_and_agent_access.sql",
    "009_policy_chunks_and_agent_runs.sql",
)

# agent/.env (gitignored). Real environment variables win over the file.
DEFAULT_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


@dataclass(frozen=True)
class Settings:
    database_url: str
    port: int = 8000
    pool_size: int = 4
    google_api_key: str | None = None
    model: str = "gemini-3.5-flash-lite"
    embedding_model: str = "gemini-embedding-2"
    embedding_dimensions: int = 768
    daily_limit: int = 20
    owner_database_url: str | None = None
    # Internal /metrics port. 0 = no metrics server (what tests construct).
    metrics_port: int = 0
    # Step 7c improvements switched on (graph.FEATURES). Defaults are set by the eval results.
    features: frozenset[str] = frozenset()


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE lines; blank lines and # comments ignored. No shell features."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


# LangSmith reads its configuration from the process environment, not from our
# Settings. These, and only these, are copied from agent/.env into os.environ.
TRACING_VARS = ("LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_ENDPOINT")


def apply_tracing_env(env_file: Path | None = DEFAULT_ENV_FILE) -> list[str]:
    """Export the LANGSMITH_* variables found in env_file, unless already set in the environment.

    Returns the names exported (never values). With none of them in the file or
    the environment, tracing stays off and nothing is sent anywhere.
    """
    if env_file is None:
        return []
    exported: list[str] = []
    for name, value in read_env_file(env_file).items():
        if name in TRACING_VARS and value and name not in os.environ:
            os.environ[name] = value
            exported.append(name)
    return exported


def load_settings(env: dict[str, str] | None = None, env_file: Path | None = DEFAULT_ENV_FILE) -> Settings:
    e: dict[str, str] = {}
    if env_file is not None:
        e.update(read_env_file(env_file))
    e.update(os.environ if env is None else env)

    url = e.get("AGENT_DATABASE_URL", "")
    if not url.startswith("postgres://") and not url.startswith("postgresql://"):
        raise ValueError("AGENT_DATABASE_URL must be set to a postgres:// URL (the ledger_agent role)")
    port = int(e.get("PORT", "8000"))
    if not 0 < port < 65536:
        raise ValueError("PORT must be 1-65535")
    dims = int(e.get("AGENT_EMBEDDING_DIMENSIONS", "768"))
    if dims != 768:
        raise ValueError("AGENT_EMBEDDING_DIMENSIONS must be 768: policy_chunks.embedding is vector(768)")
    daily = int(e.get("AGENT_DAILY_LIMIT", "20"))
    if daily < 1:
        raise ValueError("AGENT_DAILY_LIMIT must be at least 1")
    key = e.get("GOOGLE_API_KEY") or None
    if key in ("replace-me",):
        key = None
    return Settings(
        database_url=url,
        port=port,
        pool_size=int(e.get("AGENT_POOL_SIZE", "4")),
        google_api_key=key,
        model=e.get("AGENT_MODEL", "gemini-3.5-flash-lite"),
        embedding_model=e.get("AGENT_EMBEDDING_MODEL", "gemini-embedding-2"),
        embedding_dimensions=dims,
        daily_limit=daily,
        owner_database_url=e.get("OWNER_DATABASE_URL") or None,
        metrics_port=int(e.get("AGENT_METRICS_PORT", "9102")),
        features=frozenset(f.strip() for f in e.get("AGENT_FEATURES", "").split(",") if f.strip()),
    )
