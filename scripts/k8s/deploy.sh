#!/usr/bin/env bash
# Apply the kind overlay to the running cluster and wait until everything is up.
# up.sh calls this once; call it again after any change to code or manifests
# (rebuild + `kind load` first if the code changed: see up.sh).
#
# Order of events, and why none of it needs a sleep:
#   1. the previous migrate Job is deleted (Jobs are immutable; see migrate-job.yaml)
#   2. kubectl apply -k: everything at once. api/worker pods START right away
#      but are not READY: /readyz says 503 until migrations are applied
#   3. wait for the migrate Job; on failure show its logs and stop
#   4. wait for every rollout: the api pods turn Ready by themselves once the
#      Job has finished, because /readyz starts answering 200
source "$(dirname "$0")/lib.sh"

kall get nodes >/dev/null 2>&1 || die "cluster $CTX is not reachable: run scripts/k8s/up.sh"
kc get secret ledger-secrets >/dev/null 2>&1 || die "Secret ledger-secrets is missing: run scripts/k8s/secrets.sh"

log "deleting the previous migrate and agent-ingest Jobs (if any)"
kc delete job migrate agent-ingest --ignore-not-found --wait=true

log "kubectl apply -k $OVERLAY"
kall apply -k "$OVERLAY"

log "waiting for the migrate Job (roles + migrations)"
if ! wait_job migrate 300; then
  kc logs job/migrate --all-containers=true --prefix=true || true
  kc describe job migrate | tail -20
  die "migrate Job did not complete"
fi
kc logs job/migrate --all-containers=true --prefix=true | tail -8

# Policy documents -> policy_chunks. Needs migration 009, so it runs now, not
# with everything else. Free when nothing changed (matched by content hash);
# the first run embeds every chunk. SKIP_AGENT_INGEST=1 defers it (free-tier
# quota), e.g. to run later with: kubectl apply -k k8s/overlays/kind/agent-ingest
if [[ "${SKIP_AGENT_INGEST:-0}" == "1" ]]; then
  log "SKIP_AGENT_INGEST=1: not embedding the policy documents now"
elif kc get secret agent-secrets -o jsonpath='{.data.GOOGLE_API_KEY}' 2>/dev/null | grep -q .; then
  log "embedding the policy documents (agent-ingest Job)"
  kall apply -k "$OVERLAY/agent-ingest"
  if ! wait_job agent-ingest 300; then
    kc logs job/agent-ingest || true
    die "agent-ingest Job did not complete"
  fi
  kc logs job/agent-ingest | tail -1
else
  log "no GOOGLE_API_KEY in agent-secrets: skipping policy ingestion (the agent will answer 503)"
fi

log "waiting for rollouts"
kc rollout status statefulset/postgres --timeout=180s
for d in api worker-commands worker-events mock-provider prometheus grafana agent; do
  kc rollout status deployment/"$d" --timeout=180s
done
kall -n kube-system rollout status deployment/metrics-server --timeout=180s

log "pods"
kc get pods -o wide
