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
PROMETHEUS_PORT=${PROMETHEUS_PORT:-19090}
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
CLIENT=$(python3 -c 'import json; print(json.load(open("load/out/accounts.json"))["clientId"])')  # the accounts' owner

log "3. transfer and top-up through port-forward"
pids+=("$(port_forward api "$API_PORT" 3000 /healthz)")
pids+=("$(port_forward mock-provider "$PROVIDER_PORT" 4100 /healthz)")
API=http://127.0.0.1:$API_PORT; PROVIDER=http://127.0.0.1:$PROVIDER_PORT

before_b=$(sql "SELECT balance_paise FROM accounts WHERE id = '$B'")
key="smoke-$(date +%s)"
body="{\"fromAccountId\":\"$A\",\"toAccountId\":\"$B\",\"amountPaise\":\"12345\"}"
post() { curl -sS -o "$3" -w '%{http_code}' -X POST "$1" -H 'content-type: application/json' -H "x-client-id: $CLIENT" -H "idempotency-key: $2" -D "$3.headers" -d "$body"; }
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
# Through a port-forward with curl, not `kubectl exec ... wget` in the Prometheus
# pod: its busybox wget crashed once (exit 139) and the pod should not need a client.
pids+=("$(port_forward prometheus "$PROMETHEUS_PORT" 9090 /-/ready)")
curl -sS "http://127.0.0.1:$PROMETHEUS_PORT/api/v1/targets" > /tmp/smoke-targets.json
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
[ "$(echo "$targets" | head -1 | cut -d/ -f1)" -ge 6 ] || die "fewer than 6 targets (2 api + 2 workers + 2 agents expected)"
pass "Prometheus: $(echo "$targets" | head -1) targets up, found through headless-Service DNS"

log "5. NetworkPolicy: metrics ports only from Prometheus"
# The mock-provider pod is any pod that is not Prometheus. Its image has busybox wget.
if kc exec deploy/mock-provider -- wget -T 3 -qO- http://api-metrics:9100/metrics >/dev/null 2>&1; then die "api metrics port reachable from a non-Prometheus pod"; fi
pass "mock-provider -> api-metrics:9100   blocked"
if kc exec deploy/mock-provider -- wget -T 3 -qO- http://worker-events:9101/metrics >/dev/null 2>&1; then die "worker metrics port reachable from a non-Prometheus pod"; fi
pass "mock-provider -> worker-events:9101 blocked"
kc exec deploy/mock-provider -- wget -T 3 -qO- http://api:3000/healthz >/dev/null 2>&1 || die "api public port NOT reachable from another pod"
pass "mock-provider -> api:3000           allowed (the product)"
# The positive control: Prometheus itself scrapes those ports (every target was "up" in step 4).
pass "prometheus     -> api-metrics:9100   allowed (its scrapes succeed, step 4)"

log "6. the assistant (agent): not public, and its egress is fenced"
kc rollout status deployment/agent --timeout=120s >/dev/null
AGENT_PORT=${AGENT_PORT:-18000}
pids+=("$(port_forward agent "$AGENT_PORT" 8000 /healthz)")
[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$AGENT_PORT/readyz")" = 200 ] || die "agent /readyz is not 200"
pass "agent ready (database as ledger_agent, migrations 008/009 applied)"
[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$AGENT_PORT/metrics")" = 404 ] || die "agent serves /metrics on its API port"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$AGENT_PORT/ask" -H 'content-type: application/json' -d '{"question":"hi"}')
[ "$code" = 400 ] || die "POST /ask without X-Client-Id: expected 400, got $code"
pass "GET /metrics on the API port: 404; /ask without X-Client-Id: 400 (no model call made)"

# Ingress: only pods labelled app=web may call the agent. A throwaway pod with that
# label (the agent image has python; restricted Pod Security needs the full securityContext).
probe_pod() { # NAME LABEL PYTHON_CODE -> exit status of the code
  kc delete pod "$1" --ignore-not-found --wait=true >/dev/null 2>&1
  kc apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: { name: $1, labels: { app: $2 } }
spec:
  restartPolicy: Never
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: probe
      image: ledger-agent:local
      imagePullPolicy: IfNotPresent
      command: ["python", "-c", "$3"]
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      resources: { requests: { cpu: 10m, memory: 32Mi }, limits: { cpu: 200m, memory: 96Mi } }
YAML
  for _ in $(seq 1 60); do
    phase=$(kc get pod "$1" -o jsonpath='{.status.phase}' 2>/dev/null)
    case $phase in Succeeded) kc delete pod "$1" --wait=false >/dev/null; return 0;; Failed) kc delete pod "$1" --wait=false >/dev/null; return 1;; esac
    sleep 1
  done
  kc delete pod "$1" --wait=false >/dev/null; return 2
}
GET='import urllib.request; urllib.request.urlopen(\"http://agent:8000/healthz\", timeout=4)'
probe_pod web-probe web "$GET" || die "a pod labelled app=web could NOT reach the agent"
pass "pod labelled app=web -> agent:8000   allowed (the agent's one caller)"
if probe_pod other-probe not-web "$GET"; then die "a pod NOT labelled app=web reached the agent"; fi
pass "any other pod      -> agent:8000   blocked"
if kc exec deploy/mock-provider -- wget -T 3 -qO- http://agent-metrics:9102/metrics >/dev/null 2>&1; then die "agent metrics reachable from a non-Prometheus pod"; fi
pass "mock-provider      -> agent:9102   blocked (Prometheus only)"

# Egress, from inside an agent pod.
connect() { kc exec deploy/agent -- python -c "import socket; socket.create_connection(('$1', $2), timeout=4).close()" >/dev/null 2>&1; }
connect postgres 5432 || die "agent cannot reach postgres:5432"
pass "agent -> postgres:5432                     allowed"
connect generativelanguage.googleapis.com 443 || die "agent cannot reach the Gemini API on 443"
pass "agent -> generativelanguage.googleapis.com:443 allowed (public address, port 443)"
if connect api 3000; then die "agent reached the ledger api"; fi
pass "agent -> api:3000                          blocked"
if connect mock-provider 4100; then die "agent reached the mock provider"; fi
pass "agent -> mock-provider:4100                blocked"

log "7. reconciliation"
scripts/k8s/reconcile-now.sh | tail -12

log "smoke test passed"
