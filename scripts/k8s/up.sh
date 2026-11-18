#!/usr/bin/env bash
# One command: a local Kubernetes cluster running the whole ledger.
#
#   scripts/k8s/up.sh            create the kind cluster, build + load images,
#                                create Secrets from .env, apply, wait
#   scripts/k8s/smoke.sh         then prove it works
#   scripts/k8s/down.sh          delete the cluster (and everything in it)
#
# Safe to re-run: an existing cluster is reused, images are rebuilt and
# reloaded, manifests re-applied (a normal "deploy").
source "$(dirname "$0")/lib.sh"

need docker; need kubectl; need kind " (brew install kind)"
docker info >/dev/null 2>&1 || die "Docker is not running"

# First run: the node image (~1 GB) plus the loaded images (~1 GB inside the node).
MIN_FREE_GB=${MIN_FREE_GB:-4}
free_gb=$(df -g / | awk 'NR == 2 { print $4 }')
[ "$free_gb" -ge "$MIN_FREE_GB" ] || die "only ${free_gb} GB free on / (MIN_FREE_GB=$MIN_FREE_GB); free some space first"
echo "docker: $(docker info --format '{{.NCPU}} {{.MemTotal}}' | awk '{ printf "%s CPUs, %.1f GiB of memory", $1, $2 / 1024 / 1024 / 1024 }')"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  log "cluster $CLUSTER exists; reusing it"
else
  log "creating kind cluster $CLUSTER (one node)"
  kind create cluster --config "$OVERLAY/cluster.yaml" --wait 120s
fi
kall get nodes

log "building images"
docker build --target app -t ledger-service:local . -q
docker build --target mock-provider -t ledger-mock-provider:local . -q
docker build -t ledger-agent:local agent/ -q

# Third-party images are pulled here (once, cached by Docker) and copied into
# the node, so the cluster never downloads anything itself.
THIRD_PARTY="pgvector/pgvector:pg17 prom/prometheus:v3.15.1 grafana/grafana:12.4.15 grafana/k6:1.8.2 registry.k8s.io/metrics-server/metrics-server:v0.9.1"
for img in $THIRD_PARTY; do docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img"; done

log "loading images into the node"
# shellcheck disable=SC2086
kind load docker-image --name "$CLUSTER" ledger-service:local ledger-mock-provider:local ledger-agent:local $THIRD_PARTY

log "secrets from .env"
scripts/k8s/secrets.sh

scripts/k8s/deploy.sh

log "memory"
docker stats --no-stream --format 'kind node container: {{.MemUsage}}' "$CLUSTER-control-plane"
kall top pods -n "$NS" 2>/dev/null || echo "(kubectl top needs ~30 s of metrics-server samples; try again shortly)"

cat <<EOF

Up. Next:
  scripts/k8s/smoke.sh                                      prove it works
  kubectl --context $CTX -n $NS port-forward svc/grafana 3001:3000      Grafana   http://localhost:3001
  kubectl --context $CTX -n $NS port-forward svc/prometheus 9090        Prometheus http://localhost:9090
  kubectl --context $CTX -n $NS get pods -w
EOF
