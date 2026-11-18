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

log "deleting the previous migrate Job (if any)"
kc delete job migrate --ignore-not-found --wait=true

log "kubectl apply -k $OVERLAY"
kall apply -k "$OVERLAY"

log "waiting for the migrate Job (roles + migrations)"
if ! wait_job migrate 300; then
  kc logs job/migrate --all-containers=true --prefix=true || true
  kc describe job migrate | tail -20
  die "migrate Job did not complete"
fi
kc logs job/migrate --all-containers=true --prefix=true | tail -8

# The web demo's people (does nothing when they exist). Needs the migrations.
log "seeding the web demo's fictional people (seed-demo Job)"
kc delete job seed-demo --ignore-not-found --wait=true >/dev/null
kall apply -k "$OVERLAY/seed-demo" >/dev/null
if ! wait_job seed-demo 120; then kc logs job/seed-demo || true; die "seed-demo Job failed"; fi
kc logs job/seed-demo | tail -3

log "waiting for rollouts"
kc rollout status statefulset/postgres --timeout=180s
for d in api worker-commands worker-events mock-provider prometheus grafana web; do
  kc rollout status deployment/"$d" --timeout=180s
done
kall -n kube-system rollout status deployment/metrics-server --timeout=180s

log "pods"
kc get pods -o wide
