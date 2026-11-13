#!/usr/bin/env bash
# How fast does the events lane drain, and what limits it?
#
#   load/outbox-drain-bench.sh 1 2 4 8        (concurrency values to try; default "1 2 4 8")
#   ROWS=20000 load/outbox-drain-bench.sh 4
#
# Needs the full stack running (npm run stack:up). For each concurrency N it:
#   1. stops worker-events
#   2. queues ROWS notification rows (as the postgres superuser, straight into outbox)
#   3. starts worker-events with WORKER_CONCURRENCY=N and times the drain
#   4. while draining, samples CPU (docker stats) and what the worker's database
#      sessions are waiting on (pg_stat_activity.wait_event_type)
# and prints one line per N. The steady rate is measured between 90% and 10%
# remaining, so container start-up does not distort it.
#
# Rows go to the real mock-provider sink, so its work is part of the measurement.
set -euo pipefail
cd "$(dirname "$0")/.."

ROWS=${ROWS:-20000}
LEVELS=${*:-1 2 4 8}
DC=(docker compose -f docker-compose.full.yml)
psql_q() { "${DC[@]}" exec -T postgres psql -U postgres -d ledger -tAc "$1"; }
pending_events() { psql_q "SELECT count(*) FROM outbox WHERE status = 'pending' AND type NOT LIKE 'provider.%'"; }
cpu_of() { docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | awk -v n="ledger-full-$1-1" '$1 == n { sub("%", "", $2); print $2 }'; }

printf '%-4s %9s %10s %9s %9s %9s  %s\n' "N" "drain_s" "rows/s" "pg_cpu%" "wrk_cpu%" "sink_cpu%" "worker DB sessions were: (samples)"
for N in $LEVELS; do
  "${DC[@]}" stop -t 30 worker-events >/dev/null 2>&1
  psql_q "INSERT INTO outbox (type, payload) SELECT 'transfer.posted', jsonb_build_object('bench', g) FROM generate_series(1, $ROWS) g" >/dev/null

  WORKER_EVENTS_CONCURRENCY=$N "${DC[@]}" up -d --no-deps worker-events >/dev/null 2>&1
  start=$(date +%s.%N 2>/dev/null || python3 -c 'import time; print(time.time())')
  now() { python3 -c 'import time; print(time.time())'; }
  start=$(now)

  t90="" ; t10="" ; c90=0 ; c10=0 ; pg=() ; wk=() ; sk=() ; waits=""
  while :; do
    p=$(pending_events)
    t=$(now)
    if [ -z "$t90" ] && [ "$p" -le $((ROWS * 9 / 10)) ]; then t90=$t; c90=$p; fi
    if [ -z "$t10" ] && [ "$p" -le $((ROWS / 10)) ]; then t10=$t; c10=$p; fi
    # Sample resources while the drain is in its steady middle part.
    if [ -n "$t90" ] && [ -z "$t10" ] && [ ${#pg[@]} -lt 3 ]; then
      pg+=("$(cpu_of postgres)"); wk+=("$(cpu_of worker-events)"); sk+=("$(cpu_of mock-provider)")
      waits+=$(psql_q "SELECT COALESCE(wait_event_type || ':' || wait_event, 'on-CPU/active') FROM pg_stat_activity
                        WHERE usename = 'ledger_worker' AND state = 'active' AND query NOT LIKE '%pg_stat_activity%'")$'\n'
    fi
    [ "$p" -eq 0 ] && break
    sleep 0.2
  done
  end=$(now)

  avg() { printf '%s\n' "$@" | awk '{ s += $1 } END { if (NR) printf "%.0f", s / NR; else print "-" }'; }
  rate=$(python3 -c "print(round(($c90 - $c10) / ($t10 - $t90)))" 2>/dev/null || echo "-")
  waits_summary=$(printf '%s' "$waits" | grep -v '^$' | sort | uniq -c | sort -rn | awk '{ printf "%s %s, ", $2, $1 }' | sed 's/, $//')
  printf '%-4s %9.1f %10s %9s %9s %9s  %s\n' "$N" "$(python3 -c "print($end - $start)")" "$rate" "$(avg "${pg[@]}")" "$(avg "${wk[@]}")" "$(avg "${sk[@]}")" "${waits_summary:-none sampled}"
done

# Leave the stack as configured in docker-compose.full.yml.
"${DC[@]}" up -d --no-deps worker-events >/dev/null 2>&1
