#!/usr/bin/env bash
# Smoke test against the running cluster. Fails loudly at the first problem.
#
#   1. every pod Ready, the migrate Job complete
#   2. seed accounts (in-cluster Job)
#   3. through a port-forward: a transfer (201) and its idempotent replay,
#      then a top-up (202) that the mock provider confirms and the webhook posts
#   4. the public port serves no /metrics; Prometheus sees every target up
#   5. the NetworkPolicy really blocks the metrics ports from a non-Prometheus pod
#   6. a reconcile Job runs now and finds 0 problems
source "$(dirname "$0")/lib.sh"
need curl; need python3

API_PORT=${API_PORT:-18080}
PROVIDER_PORT=${PROVIDER_PORT:-18100}
pids=()
cleanup() { for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
pass() { printf '  \033[32mok\033[0m  %s\n' "$*"; }
jsonv() { python3 -c 'import json,sys; v=json.load(sys.stdin); [v:=v[k] for k in sys.argv[1].split(".")]; print(v)' "$1"; }
sql() { kc exec postgres-0 -- psql -U postgres -d ledger -tAc "$1"; }

log "1. everything ready"
kc wait --for=condition=ready pod -l 'app in (postgres,api,worker-commands,worker-events,mock-provider,prometheus,grafana)' --timeout=120s >/dev/null
[ "$(kc get job migrate -o jsonpath='{.status.succeeded}')" = 1 ] || die "migrate Job has not succeeded"
pass "$(kc get pods --no-headers | grep -c Running) pods running, migrate Job succeeded"
kc get pods

log "2. seed accounts"
scripts/k8s/seed.sh
A=$(python3 -c 'import json; print(json.load(open("load/out/accounts.json"))["accounts"][0])')
B=$(python3 -c 'import json; print(json.load(open("load/out/accounts.json"))["accounts"][1])')

log "3. transfer and top-up through port-forward"
pids+=("$(port_forward api "$API_PORT" 3000 /healthz)")
pids+=("$(port_forward mock-provider "$PROVIDER_PORT" 4100 /healthz)")
API=http://127.0.0.1:$API_PORT; PROVIDER=http://127.0.0.1:$PROVIDER_PORT

before_b=$(sql "SELECT balance_paise FROM accounts WHERE id = '$B'")
key="smoke-$(date +%s)"
body="{\"fromAccountId\":\"$A\",\"toAccountId\":\"$B\",\"amountPaise\":\"12345\"}"
post() { curl -sS -o "$3" -w '%{http_code}' -X POST "$1" -H 'content-type: application/json' -H 'x-client-id: smoke' -H "idempotency-key: $2" -D "$3.headers" -d "$body"; }
code=$(post "$API/transfers" "$key" /tmp/smoke-transfer.json)
[ "$code" = 201 ] || { cat /tmp/smoke-transfer.json; die "transfer: expected 201, got $code"; }
pass "transfer 201: $(cat /tmp/smoke-transfer.json)"
code=$(post "$API/transfers" "$key" /tmp/smoke-replay.json)
grep -qi '^idempotent-replayed: true' /tmp/smoke-replay.json.headers || die "replay: no Idempotent-Replayed header"
[ "$code" = 201 ] && cmp -s /tmp/smoke-transfer.json /tmp/smoke-replay.json || die "replay: different response"
pass "same key again: same stored response, Idempotent-Replayed: true"
after_b=$(sql "SELECT balance_paise FROM accounts WHERE id = '$B'")
[ $((after_b - before_b)) -eq 12345 ] || die "balance of B moved by $((after_b - before_b)), expected 12345"
pass "B's balance moved by exactly 12345 paise (one transfer, not two)"

body="{\"accountId\":\"$A\",\"amountPaise\":\"50000\"}"
code=$(post "$API/topups" "topup-$key" /tmp/smoke-topup.json)
[ "$code" = 202 ] || { cat /tmp/smoke-topup.json; die "topup: expected 202, got $code"; }
topup=$(jsonv topupId < /tmp/smoke-topup.json)
pass "top-up 202 accepted: $topup"
payment=""
for _ in $(seq 1 40); do   # the commands worker asks the provider for the payment
  payment=$(curl -sS "$PROVIDER/payments?reference=$topup" | python3 -c 'import json,sys; p=json.load(sys.stdin); print(p[0]["id"] if p else "")')
  [ -n "$payment" ] && break; sleep 0.5
done
[ -n "$payment" ] || die "the provider never received a payment for $topup (is worker-commands running?)"
pass "worker-commands created provider payment $payment"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$PROVIDER/payments/$payment/succeed" -H 'content-type: application/json' -d '{}')
[ "$code" = 202 ] || die "provider succeed: expected 202, got $code"
status=""
for _ in $(seq 1 40); do   # the provider signs a webhook -> api posts the top-up
  status=$(sql "SELECT status FROM transactions WHERE id = '$topup'")
  [ "$status" = posted ] && break; sleep 0.5
done
[ "$status" = posted ] || die "top-up $topup is '$status', expected 'posted'"
pass "signed webhook received: top-up posted (transaction status = posted)"

log "4. metrics are internal"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/metrics")
[ "$code" = 404 ] || die "public port serves /metrics ($code)"
pass "GET /metrics on the public port: 404"
kc exec deploy/prometheus -- wget -qO- http://127.0.0.1:9090/api/v1/targets > /tmp/smoke-targets.json
targets=$(python3 - /tmp/smoke-targets.json <<'EOF'
import json, sys
t = json.load(open(sys.argv[1]))["data"]["activeTargets"]
up = [x for x in t if x["health"] == "up"]
print(f"{len(up)}/{len(t)}")
for x in t:
    print("      {:7s} {:45s} {}".format(x["labels"]["job"], x["scrapeUrl"], x["health"]))
EOF
)
echo "$targets" | tail -n +2
[ "$(echo "$targets" | head -1 | cut -d/ -f1)" = "$(echo "$targets" | head -1 | cut -d/ -f2)" ] || die "not every Prometheus target is up"
[ "$(echo "$targets" | head -1 | cut -d/ -f1)" -ge 4 ] || die "fewer than 4 targets (2 api + 2 workers expected)"
pass "Prometheus: $(echo "$targets" | head -1) targets up, found through headless-Service DNS"

log "5. NetworkPolicy: metrics ports only from Prometheus"
# The mock-provider pod is any pod that is not Prometheus. Its image has busybox wget.
if kc exec deploy/mock-provider -- wget -T 3 -qO- http://api-metrics:9100/metrics >/dev/null 2>&1; then die "api metrics port reachable from a non-Prometheus pod"; fi
pass "mock-provider -> api-metrics:9100   blocked"
if kc exec deploy/mock-provider -- wget -T 3 -qO- http://worker-events:9101/metrics >/dev/null 2>&1; then die "worker metrics port reachable from a non-Prometheus pod"; fi
pass "mock-provider -> worker-events:9101 blocked"
kc exec deploy/mock-provider -- wget -T 3 -qO- http://api:3000/healthz >/dev/null 2>&1 || die "api public port NOT reachable from another pod"
pass "mock-provider -> api:3000           allowed (the product)"
kc exec deploy/prometheus -- wget -T 3 -qO- http://api-metrics:9100/metrics 2>/dev/null | grep -q '^http_requests_total' || die "Prometheus cannot reach the api metrics port"
pass "prometheus     -> api-metrics:9100   allowed"

log "6. reconciliation"
scripts/k8s/reconcile-now.sh | tail -12

log "smoke test passed"
