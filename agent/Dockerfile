# The assistant service: Python 3.12, dependencies from uv.lock, non-root.
#
#   docker build -t ledger-agent:local agent/
#
# Stages:
#   deps     uv installs the locked dependencies into /app/.venv (no dev tools)
#   runtime  python:3.12-slim + the venv + the package, as user "agent"
ARG PYTHON_IMAGE=python:3.12-slim

FROM ${PYTHON_IMAGE} AS deps
COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
# --frozen: exactly uv.lock, or fail. --no-dev: no pytest/ruff/mypy in the image.
RUN uv sync --frozen --no-dev

FROM ${PYTHON_IMAGE} AS runtime
# uid 1000, like the Node images: the same Kubernetes securityContext works.
# No package manager at run time (the Node images drop npm for the same reason):
# nothing needs pip once the venv exists, and one less tool to abuse.
RUN useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin agent \
    && rm -rf /usr/local/lib/python3.12/site-packages/pip* /usr/local/lib/python3.12/ensurepip /usr/local/bin/pip*
WORKDIR /app
COPY --from=deps /app/.venv /app/.venv
COPY ledger_agent ./ledger_agent
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER agent
EXPOSE 8000
# uvicorn directly (not through a shell): SIGTERM reaches the server.
CMD ["uvicorn", "ledger_agent.api:app", "--host", "0.0.0.0", "--port", "8000"]
