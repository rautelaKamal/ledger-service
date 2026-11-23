#!/usr/bin/env bash
# Creates the Secrets from your local .env. Nothing here is ever committed.
#
#   scripts/k8s/secrets.sh                 (ENV_FILE=.env by default)
#
#   ledger-secrets  POSTGRES_PASSWORD, LEDGER_*_PASSWORD (for the roles Job),
#                   OWNER/DATABASE/WORKER/RECONCILER_DATABASE_URL (in-cluster
#                   host "postgres"), WEBHOOK_SECRET
#   grafana-admin   admin-password  (GRAFANA_ADMIN_PASSWORD, default admin-local-only)
#   web-secrets     SESSION_SECRET  signs the web demo's persona cookie: WEB_SESSION_SECRET
#                   from .env, else the value already in the cluster (so a redeploy
#                   does not log everyone out), else a new random one
#
# The passwords are taken from the URLs in .env, so one file stays the source
# of truth. Passwords with URL-special characters (@ : / %) would have to be
# percent-encoded in the URLs; the local defaults have none.
source "$(dirname "$0")/lib.sh"

ENV_FILE=${ENV_FILE:-.env}
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found: cp .env.example .env"

# `|| true`: a key that is absent is an empty value (req below reports it), not
# a crash: under pipefail, grep's exit 1 would otherwise end the script silently.
val() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
pw_of() { local p=${1#postgres://}; p=${p#*:}; echo "${p%@*}"; }   # postgres://user:PASS@host/db -> PASS
req() { [ -n "$2" ] || die "$1 is missing from $ENV_FILE"; }

POSTGRES_PASSWORD=$(val POSTGRES_PASSWORD);  req POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
WEBHOOK_SECRET=$(val WEBHOOK_SECRET);        req WEBHOOK_SECRET "$WEBHOOK_SECRET"
OWNER_PW=$(pw_of "$(val OWNER_DATABASE_URL)");           req OWNER_DATABASE_URL "$OWNER_PW"
APP_PW=$(pw_of "$(val DATABASE_URL)");                   req DATABASE_URL "$APP_PW"
WORKER_PW=$(pw_of "$(val WORKER_DATABASE_URL)");         req WORKER_DATABASE_URL "$WORKER_PW"
RECONCILER_PW=$(pw_of "$(val RECONCILER_DATABASE_URL)"); req RECONCILER_DATABASE_URL "$RECONCILER_PW"
AGENT_PW=$(pw_of "$(val AGENT_DATABASE_URL)");           req AGENT_DATABASE_URL "$AGENT_PW"
GRAFANA_ADMIN_PASSWORD=$(val GRAFANA_ADMIN_PASSWORD); GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:-admin-local-only}

DB_HOST=${DB_HOST:-postgres}   # the Service name inside the namespace
url() { echo "postgres://$1:$2@$DB_HOST:5432/ledger"; }

# The namespace may not exist yet on the very first run; the Secrets must be
# there before the workloads are applied.
kall create namespace "$NS" --dry-run=client -o yaml | kall apply -f - >/dev/null

# `create --dry-run | apply`: idempotent, and the values never touch the disk.
kc create secret generic ledger-secrets \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=LEDGER_OWNER_PASSWORD="$OWNER_PW" \
  --from-literal=LEDGER_APP_PASSWORD="$APP_PW" \
  --from-literal=LEDGER_WORKER_PASSWORD="$WORKER_PW" \
  --from-literal=LEDGER_RECONCILER_PASSWORD="$RECONCILER_PW" \
  --from-literal=LEDGER_AGENT_PASSWORD="$AGENT_PW" \
  --from-literal=OWNER_DATABASE_URL="$(url ledger_owner "$OWNER_PW")" \
  --from-literal=DATABASE_URL="$(url ledger_app "$APP_PW")" \
  --from-literal=WORKER_DATABASE_URL="$(url ledger_worker "$WORKER_PW")" \
  --from-literal=RECONCILER_DATABASE_URL="$(url ledger_reconciler "$RECONCILER_PW")" \
  --from-literal=AGENT_DATABASE_URL="$(url ledger_agent "$AGENT_PW")" \
  --from-literal=WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  --dry-run=client -o yaml | kc apply -f - >/dev/null
kc create secret generic grafana-admin --from-literal=admin-password="$GRAFANA_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | kc apply -f - >/dev/null

# The assistant's own Secret, from agent/.env: the model API key and the
# optional LangSmith settings. Only the variables present are written; the
# agent treats each one as optional (no key: /ask answers 503).
AGENT_ENV_FILE=${AGENT_ENV_FILE:-agent/.env}
agent_args=()
if [ -f "$AGENT_ENV_FILE" ]; then
  for name in GOOGLE_API_KEY LANGSMITH_TRACING LANGSMITH_API_KEY LANGSMITH_PROJECT; do
    value=$(grep -E "^$name=" "$AGENT_ENV_FILE" | tail -1 | cut -d= -f2- || true)
    [ -n "$value" ] && agent_args+=(--from-literal="$name=$value")
  done
fi
kc create secret generic agent-secrets ${agent_args[@]+"${agent_args[@]}"} \
  --dry-run=client -o yaml | kc apply -f - >/dev/null

SESSION_SECRET=$(val WEB_SESSION_SECRET)
[ -n "$SESSION_SECRET" ] || SESSION_SECRET=$(kc get secret web-secrets -o jsonpath='{.data.SESSION_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)
[ -n "$SESSION_SECRET" ] || SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
kc create secret generic web-secrets --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --dry-run=client -o yaml | kc apply -f - >/dev/null

echo "secrets ledger-secrets, grafana-admin, agent-secrets (${#agent_args[@]} values from $AGENT_ENV_FILE) and web-secrets written to $CTX/$NS"
echo "(variable names in agent-secrets, never values: $(printf '%s\n' ${agent_args[@]+"${agent_args[@]}"} | sed -E 's/^--from-literal=([A-Z_]+)=.*/\1/' | tr '\n' ' '))"
case $APP_PW in *_local) echo "note: these are the LOCAL default passwords from .env; fine for kind, never for a real cluster" ;; esac
