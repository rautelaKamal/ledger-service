# Step 7f, explained: the whole system on kind, rebuilt from the repo

Step 7f deploys `main` at `cba63be` (step 7e merged) on the local kind cluster. That covers
the API, both workers, the assistant and the web app, plus Postgres, the mock payment
provider, Prometheus, Grafana and metrics-server. The 7e features stay off: `AGENT_FEATURES`
is not set anywhere in `k8s/`.

Everything was built from the repo on 26 Nov 2026, after Docker lost all its data (images,
volumes and the old cluster). Nothing was restored from before. The README now has a backup
step for the dev database ("Back up the dev database before any risky change").

## 1. What ran, in order

| step | command | result |
|---|---|---|
| Docker's disk is really there | `ls …/Docker.raw`, `lsof +L1 \| grep -i docker.raw` | file present, nothing deleted-but-open |
| dev and eval Postgres | `npm run db:up && npm run migrate` | 13 migrations applied to `ledger` |
| eval ledger | `eval.seed.seed()` then `check_seed()` | 7 accounts, 29 transactions, 0 problems |
| policies | `scripts/ingest_policies.py` (`--dry-run` first) | 43 chunks, **1 embedding request** |
| make room | `docker compose stop` (the volume stays) | no other containers running |
| images | the four `docker build`s from `up.sh`, before the cluster exists | 195 s |
| cluster | `SKIP_AGENT_INGEST=1 scripts/k8s/up.sh` | node Ready after 17 s; every rollout complete |
| policies in the cluster | the 43 chunks copied from the dev database | **0 embedding requests** |
| proof | `scripts/k8s/smoke.sh` | passed, all 8 sections |

The images were built before the cluster existed, so the builds (`npm ci`, `next build`)
did not compete with a running cluster for Docker's 3.8 GiB. `up.sh` then rebuilt them from
cache in seconds.

## 2. The policies are copied, not embedded twice

The cluster has its own Postgres, so its `agent-ingest` Job would embed the same 43 chunks a
second time. Instead, the deploy skipped it (`SKIP_AGENT_INGEST=1`) and the rows embedded a
minute earlier went in as data:

```bash
docker compose exec -T postgres pg_dump -U postgres -d ledger --data-only -t policy_chunks \
  > backups/policy_chunks.sql
kubectl --context kind-ledger -n ledger exec -i postgres-0 -- \
  psql -U postgres -d ledger -v ON_ERROR_STOP=1 -q < backups/policy_chunks.sql
```

The ingest script, run with `--dry-run` inside an agent pod, then reported `would insert 0,
would delete 0, kept 43 chunks (gemini-embedding-2)`. Chunks are matched by content hash, so
the cluster's data is exactly what the Job would have written. The rebuild made one embedding
request in total and no chat calls. The smoke test calls `/ask` only without a client id,
which is refused before any model call.

## 3. Smoke test (26 Nov, 16:15 IST)

| section | checked |
|---|---|
| 1. ready | 12 pods running, migrate Job succeeded |
| 2. seed | 10 funded accounts |
| 3. money | transfer 201; same key again returns the stored response with `Idempotent-Replayed: true`; balance moved once; top-up 202, the worker created the provider payment, the signed webhook posted it |
| 4. metrics | `/metrics` 404 on the public port; Prometheus 6/6 targets up (2 api, 2 workers, 2 agents) |
| 5. NetworkPolicy | metrics ports blocked from a non-Prometheus pod; the API's public port allowed |
| 6. assistant | ready as `ledger_agent`; only `app=web` pods may call it; it reaches Postgres and Gemini on 443, never the API or the provider |
| 7. web app | persona picker, session cookie without a client id, overview page, `/system` through the API's internal port; web → API allowed, web → Postgres blocked |
| 8. reconcile | a manual run of the CronJob: 0 problems in all 5 checks |

## 4. Memory: all four services fit

The Mac has 8 GB; Docker's VM has 3.83 GiB. After the smoke test:

| | memory |
|---|---|
| kind node container (control plane + every pod) | 2.24 GiB of 3.83 GiB |
| grafana | 179 MiB (240 MiB at start; limit 256 MiB) |
| postgres | 115 MiB |
| agent ×2 | 115 + 106 MiB |
| prometheus | 78 MiB |
| web ×2 | 59 + 49 MiB |
| api ×2 | 54 + 36 MiB |
| workers, mock provider | about 30 MiB each |

No pod restarted, and neither did the control plane (etcd, apiserver, scheduler and
controller-manager all at 0 restarts). The host was swapping heavily the whole time (6 GB swap
nearly full), so nothing else heavy should run alongside the cluster. No service had to be
left out.

**Watch Grafana.** At start-up it came within 16 MiB of its 256 MiB limit. It is not needed
for any test; if it is ever OOM-killed, raise its limit in `k8s/base/observability/grafana.yaml`
or scale it to 0 on the laptop.

## 5. To do it again

```bash
npm run db:up && npm run migrate                    # dev + eval database
cd agent && uv run python scripts/ingest_policies.py --dry-run   # count the chunks first
uv run python scripts/ingest_policies.py && cd ..
docker compose stop                                 # free memory; the volume stays
SKIP_AGENT_INGEST=1 scripts/k8s/up.sh               # cluster without a second embedding run
# copy policy_chunks as in section 2
scripts/k8s/smoke.sh
```

Never `docker restart` the kind node: etcd keeps its data in memory there, and a restart wipes
the cluster. `scripts/k8s/down.sh` and `up.sh` rebuild it.
