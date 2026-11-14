#!/usr/bin/env bash
# HPA demo: push CPU up with k6, watch the api scale 2 -> 4, stop, watch it
# come back to 2. Prints one line every 10 s.
#
#   scripts/k8s/hpa-demo.sh                 (VUS=40 DURATION=3m)
#   output: load/out/k8s-hpa/
source "$(dirname "$0")/lib.sh"
need python3

VUS=${VUS:-40}; DURATION=${DURATION:-3m}
OUT=load/out/k8s-hpa
rm -rf "$OUT"; mkdir -p "$OUT"
[ -f load/out/accounts.json ] || scripts/k8s/seed.sh
# If this script dies early, the k6 Job must not keep loading the cluster.
trap 'k6_done 2>/dev/null || kc delete job k6 --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

log "HPA before"
kc get hpa api

log "k6: $VUS VUs for $DURATION"
k6_start "$VUS" "$DURATION"
t_start=$(now)
min=$(kc get hpa api -o jsonpath='{.spec.minReplicas}')

printf '%-8s %-6s %-9s %-8s %-6s %s\n' time load cpu/target desired ready note | tee "$OUT/table.txt"
peak=0; k6_end=""
while :; do
  cpu=$(kc get hpa api -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null)
  target=$(kc get hpa api -o jsonpath='{.spec.metrics[0].resource.target.averageUtilization}')
  desired=$(kc get hpa api -o jsonpath='{.status.desiredReplicas}')
  ready=$(kc get deployment api -o jsonpath='{.status.readyReplicas}')
  if [ -z "$k6_end" ] && k6_done; then k6_end=$(now); fi
  load=$([ -z "$k6_end" ] && echo "on" || echo "off")
  [ "${desired:-0}" -gt "$peak" ] && peak=$desired
  note=""
  [ -n "$k6_end" ] && [ "$desired" = "$min" ] && [ "$ready" = "$min" ] && note="back to minimum"
  printf '%-8s %-6s %-9s %-8s %-6s %s\n' "$(date +%T)" "$load" "${cpu:-?}%/${target}%" "$desired" "${ready:-0}" "$note" | tee -a "$OUT/table.txt"
  [ -n "$note" ] && break
  [ -n "$k6_end" ] && [ $(( $(now) - k6_end )) -gt 600 ] && die "did not scale back to $min within 10 min after the load stopped"
  [ $(( $(now) - t_start )) -gt 1200 ] && die "demo took more than 20 min"
  sleep 10
done

log "k6 result"
k6_collect "$OUT"

log "HPA events"
kc describe hpa api | sed -n '/^Events/,$p' | grep -E 'Scaled|SuccessfulRescale' | sed 's/^/  /' || true
echo
echo "peak replicas: $peak (max $(kc get hpa api -o jsonpath='{.spec.maxReplicas}')), back to $min after the load stopped. Table in $OUT/table.txt"
