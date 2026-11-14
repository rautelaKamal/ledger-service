#!/usr/bin/env bash
# Zero-downtime deploy test.
#
# k6 runs INSIDE the cluster against the api Service for DURATION. After WARMUP
# seconds the api Deployment is rolled (kubectl rollout restart: every pod is
# replaced, as a new image would). Afterwards: how many requests failed?
# Target: 0. Also measured, per replaced pod: how long after Kubernetes began
# terminating it did SIGTERM actually arrive (the preStop sleep), and how long
# the app took to drain.
#
#   scripts/k8s/zero-downtime.sh                  (VUS=10 DURATION=3m WARMUP=45)
#   output: load/out/k8s-zero-downtime/  (k6 log + summary, pod logs, timeline)
source "$(dirname "$0")/lib.sh"
need python3

VUS=${VUS:-10}; DURATION=${DURATION:-3m}; WARMUP=${WARMUP:-45}
OUT=load/out/k8s-zero-downtime
rm -rf "$OUT"; mkdir -p "$OUT"
[ -f load/out/accounts.json ] || scripts/k8s/seed.sh

bg=()
cleanup() {
  for p in ${bg[@]+"${bg[@]}"}; do kill "$p" 2>/dev/null || true; done
  # If this script dies early, the k6 Job must not keep loading the cluster.
  k6_done 2>/dev/null || kc delete job k6 --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "k6: $VUS VUs for $DURATION, inside the cluster, against http://api:3000"
k6_start "$VUS" "$DURATION"
t_start=$(now)

old=$(kc get pods -l app=api -o jsonpath='{.items[*].metadata.name}')
echo "api pods before: $old"
for p in $old; do
  kc logs -f "$p" > "$OUT/$p.log" 2>/dev/null & bg+=($!)
  # Record the moment Kubernetes marked this pod for deletion.
  ( while kc get pod "$p" -o jsonpath='{.metadata.deletionTimestamp}' > "$OUT/$p.deleted.tmp" 2>/dev/null; do
      if [ -s "$OUT/$p.deleted.tmp" ]; then mv "$OUT/$p.deleted.tmp" "$OUT/$p.deleted"; break; fi; sleep 0.5; done ) & bg+=($!)
done
# One line per second: which api pods exist, ready or not, terminating or not.
( while :; do
    printf '%s  ' "$(date +%T)"
    kc get pods -l app=api --no-headers -o custom-columns='N:.metadata.name,R:.status.containerStatuses[0].ready,D:.metadata.deletionTimestamp' 2>/dev/null \
      | awk '{ s = ($2 == "true") ? "ready" : "not-ready"; if ($3 != "<none>") s = "terminating"; printf "%s=%s  ", substr($1, 5), s } END { print "" }'
    sleep 1
  done ) > "$OUT/timeline.txt" & bg+=($!)

echo "warming up for ${WARMUP}s ..."
sleep "$WARMUP"

log "rolling update: kubectl rollout restart deployment/api"
t0=$(now)
kc rollout restart deployment/api
kc rollout status deployment/api --timeout=300s
t1=$(now)
echo "rollout took $((t1 - t0)) s"
sleep 3
echo "api pods after:  $(kc get pods -l app=api -o jsonpath='{.items[*].metadata.name}')"

log "per replaced pod: deletion -> SIGTERM -> drained"
for p in $old; do
  # Informative only: a parsing problem here must not lose the k6 result below.
  python3 - "$p" "$OUT/$p.deleted" "$OUT/$p.log" <<'EOF' || echo "  $p: could not analyse its log"
import json, sys, datetime
name, deleted_file, log_file = sys.argv[1:]
try:
    deleted = datetime.datetime.fromisoformat(open(deleted_file).read().strip().replace("Z", "+00:00")).timestamp()
except FileNotFoundError:
    print(f"  {name}: deletionTimestamp not captured"); sys.exit(0)
def when(j):  # pino writes "time" as an ISO string here (src/logger.ts); accept epoch ms too
    t = j["time"]
    return t / 1000 if isinstance(t, (int, float)) else datetime.datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
started = done = None
for line in open(log_file):
    try: j = json.loads(line)
    except ValueError: continue
    if j.get("msg", "").startswith("shutdown started"): started = when(j)
    if j.get("msg") == "shutdown complete": done = when(j)
if started is None:
    print(f"  {name}: no 'shutdown started' line in its log"); sys.exit(0)
drain = f"{done - started:.2f} s" if done else "n/a"
print(f"  {name}: SIGTERM {started - deleted:.1f} s after deletion began (preStop sleep 5 s; deletionTimestamp has 1 s resolution), drained in {drain}")
EOF
done

log "waiting for k6 to finish"
limit=$(( $(secs "$DURATION") + 150 ))
while ! k6_done; do [ $(( $(now) - t_start )) -gt "$limit" ] && die "k6 did not finish"; sleep 3; done
k6_collect "$OUT"
failed=$(k6_failed_requests "$OUT")

log "pod timeline around the rollout (one line per change)"
awk '{ line = $0; sub(/^[0-9:]+  /, "", line); if (line != prev) print; prev = line }' "$OUT/timeline.txt"

log "result"
if [ "$failed" -eq 0 ]; then
  echo "ZERO failed requests during the rolling update ($VUS VUs, $DURATION). Details in $OUT/"
else
  echo "$failed requests FAILED during the rolling update. Details in $OUT/"
  exit 1
fi
