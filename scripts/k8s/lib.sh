# Shared by every script in scripts/k8s/. Source it; do not run it.
# shellcheck shell=bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

CLUSTER=${KIND_CLUSTER:-ledger}
CTX=kind-$CLUSTER
NS=ledger
OVERLAY=k8s/overlays/kind

# kubectl, always against OUR cluster and namespace. Never the current context:
# a script that deploys to "whatever kubectl points at" is how production gets
# a surprise one day.
kc() { kubectl --context "$CTX" -n "$NS" "$@"; }
kall() { kubectl --context "$CTX" "$@"; }

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed${2:-}"; }
now() { date +%s; }
# "3m" -> 180, "90s" -> 90, "120" -> 120
secs() { case $1 in *m) echo $(( ${1%m} * 60 )) ;; *s) echo "${1%s}" ;; *) echo "$1" ;; esac; }

# wait_job NAME [TIMEOUT_S]: 0 complete, 1 failed, 2 timed out.
wait_job() {
  local name=$1 timeout=${2:-300} start c f
  start=$(now)
  while :; do
    c=$(kc get job "$name" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)
    f=$(kc get job "$name" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)
    [ "$c" = True ] && return 0
    [ "$f" = True ] && return 1
    [ $(( $(now) - start )) -ge "$timeout" ] && return 2
    sleep 2
  done
}

# port_forward SERVICE LOCAL_PORT REMOTE_PORT PROBE_PATH -> prints the pid once it answers.
port_forward() {
  local svc=$1 lport=$2 rport=$3 path=$4 pid i
  kc port-forward "svc/$svc" "$lport:$rport" >/dev/null 2>&1 &
  pid=$!
  for i in $(seq 1 50); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$lport$path" 2>/dev/null; then echo "$pid"; return 0; fi
    sleep 0.2
  done
  kill "$pid" 2>/dev/null || true
  die "port-forward to $svc did not come up"
}

# ── k6 inside the cluster ──

# k6_start VUS DURATION: (re)creates the input ConfigMaps and the k6 Job.
k6_start() {
  local vus=$1 duration=$2
  [ -f load/out/accounts.json ] || die "load/out/accounts.json is missing: run scripts/k8s/seed.sh"
  kc create configmap k6-load --from-file=transfers.js=load/transfers.js --from-file=accounts.json=load/out/accounts.json \
    --dry-run=client -o yaml | kc apply -f - >/dev/null
  kc create configmap k6-params --from-literal=VUS="$vus" --from-literal=DURATION="$duration" \
    --from-literal=API_URL=http://api:3000 --from-literal=PROVIDER_URL=http://mock-provider:4100 \
    --dry-run=client -o yaml | kc apply -f - >/dev/null
  kc delete job k6 --ignore-not-found --wait=true >/dev/null
  kc apply -f k8s/tools/k6/job.yaml >/dev/null
  kc wait --for=condition=ready pod -l app=k6 --timeout=120s >/dev/null
}

k6_done() { # 0 when the Job has finished (either way)
  local c f
  c=$(kc get job k6 -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)
  f=$(kc get job k6 -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)
  [ "$c" = True ] || [ "$f" = True ]
}

# k6_collect OUT_DIR: saves the k6 log and summary JSON there, prints the headline numbers.
k6_collect() {
  local out=$1
  mkdir -p "$out"
  kc logs job/k6 > "$out/k6.log" 2>/dev/null || true
  sed -n '/^===SUMMARY===$/,$p' "$out/k6.log" | sed '1d' > "$out/summary.json"
  sed '/^===SUMMARY===$/,$d' "$out/k6.log" | grep -E "http_req_failed|http_reqs|http_req_duration|checks|ledger_|✓|✗" | sed 's/^/    /' || true
  python3 - "$out/summary.json" <<'EOF'
import json, sys
s = json.load(open(sys.argv[1]))
m = s["metrics"]
failed = int(m["http_req_failed"]["values"].get("passes", 0))   # k6: "passes" = requests that FAILED
total = int(m["http_reqs"]["values"]["count"])
d = m["http_req_duration"]["values"]
checks = m["checks"]["values"]
print(f"    requests: {total}   failed: {failed}   p95: {d['p(95)']:.1f} ms   p99: {d['p(99)']:.1f} ms   max: {d['max']:.0f} ms   checks ok: {checks['rate']*100:.2f}%")
EOF
}

k6_failed_requests() { python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1]))["metrics"]["http_req_failed"]["values"].get("passes",0)))' "$1/summary.json"; }
