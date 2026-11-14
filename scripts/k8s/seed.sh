#!/usr/bin/env bash
# Seed funded accounts for the load tests, inside the cluster, as ledger_owner.
# Writes load/out/accounts.json (what load/transfers.js reads).
source "$(dirname "$0")/lib.sh"

mkdir -p load/out
kc delete job seed --ignore-not-found --wait=true >/dev/null
kall apply -k "$OVERLAY/seed" >/dev/null
if ! wait_job seed 120; then kc logs job/seed || true; die "seed Job failed"; fi
# stdout has the JSON line, stderr the human line; both arrive in the log.
kc logs job/seed | grep '^{' > load/out/accounts.json
echo "seeded $(python3 -c 'import json; print(len(json.load(open("load/out/accounts.json"))["accounts"]))') accounts -> load/out/accounts.json"
