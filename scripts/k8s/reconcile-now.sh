#!/usr/bin/env bash
# Run the nightly reconciliation right now: a one-off Job from the CronJob's
# template. Exit code = the reconciliation's (1 if it found problems).
source "$(dirname "$0")/lib.sh"

name="reconcile-manual-$(date +%Y%m%d-%H%M%S)"
kc create job "$name" --from=cronjob/reconcile >/dev/null
echo "job/$name created from cronjob/reconcile"
rc=0
wait_job "$name" 180 || rc=$?
kc logs "job/$name" 2>/dev/null || true
case $rc in
  0) echo "reconciliation OK (job/$name completed)";;
  1) echo "reconciliation found problems (job/$name failed)";;
  *) die "job/$name did not finish in time";;
esac
exit $rc
