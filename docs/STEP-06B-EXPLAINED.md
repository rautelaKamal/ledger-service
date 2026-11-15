# Step 6b, explained: the whole system on Kubernetes (locally, with kind)

Step 6a put every part of the ledger in a container and ran them with Docker
Compose. Step 6b runs the same images on **Kubernetes**: a local, one-node
cluster made by [kind](https://kind.sigs.k8s.io/) (Kubernetes-in-Docker), with
the manifests written so that the same files deploy to a real cluster in 6c.

```
scripts/k8s/up.sh          create the cluster, build and load the images, Secrets from .env, apply, wait
scripts/k8s/smoke.sh       prove it: a transfer, a top-up, metrics internal, NetworkPolicy, reconcile = 0 problems
scripts/k8s/zero-downtime.sh   k6 inside the cluster while the api is rolled: failed requests must be 0
scripts/k8s/hpa-demo.sh    scale 2 -> 4 under load and back
scripts/k8s/down.sh        delete the cluster
npm run k8s:validate       what CI runs: render + schema-check, no cluster needed
```

---

## 1. The words

Kubernetes has a lot of nouns. These are the ones this step uses, each in one
breath, with the file that uses it.

| Word | Means | Here |
|---|---|---|
| **Pod** | The unit Kubernetes runs: one or more containers that share a network address. Pods are disposable; nothing refers to a pod by name. | every workload |
| **Deployment** | "Keep N identical pods of this template running, and replace them one at a time when the template changes." | `api/deployment.yaml`, workers, mock-provider, prometheus, grafana |
| **StatefulSet** | Like a Deployment, but each pod has a stable name (`postgres-0`) and its own persistent disk that follows it across restarts. | `postgres/statefulset.yaml` |
| **PersistentVolumeClaim** | "I need 1 GiB of disk that survives the pod." The cluster's storage provider fulfils it. | the StatefulSet's `volumeClaimTemplates` |
| **Service** | A stable name and virtual IP in front of a changing set of pods. `api` always resolves, whichever api pods exist right now. | `api`, `postgres`, `mock-provider`, ... |
| **Headless Service** | A Service with no virtual IP: DNS returns one record **per pod**. For when a client must talk to each pod individually. | `api-metrics`, `worker-*`, `postgres` |
| **Job** | Run a pod to completion (with retries). | `migrate-job.yaml`, seed, k6 |
| **CronJob** | Create a Job on a schedule. | `reconcile-cronjob.yaml` |
| **ConfigMap / Secret** | Key-value configuration, mounted as files or injected as environment variables. A Secret is the same thing stored and handled separately. | `config.yaml`; Secrets from `scripts/k8s/secrets.sh` |
| **Namespace** | A folder for objects, with its own policies. | `ledger` |
| **Probe** | A check the kubelet runs against each container: startup, readiness, liveness (section 3). | every Deployment |
| **HPA** | Horizontal Pod Autoscaler: changes a Deployment's replica count from a metric. | `api/hpa.yaml` |
| **PDB** | Pod Disruption Budget: "never voluntarily evict below this many". | `api/pdb.yaml` |
| **NetworkPolicy** | A firewall rule between pods. | `networkpolicy.yaml` |
| **kustomize** | Layers YAML without templating: a `base` plus `overlays` that patch it. Built into `kubectl`. | `k8s/base`, `k8s/overlays/kind` |

---

## 2. An analogy: a restaurant kitchen run by a manager who only reads the roster

Everything in Kubernetes is **declared**, never commanded. You do not say "start
a cook"; you write on the roster "two cooks on the line", and a manager who does
nothing but compare the roster to the room makes it true, forever.

- **Deployment** = the roster line "2 cooks trained on menu v3". A cook walks
  out (a pod dies)? The manager hires another. You change the roster to "menu
  v4"? The manager brings in one v4 cook, waits until they are at the pass,
  and only then sends a v3 cook home (rolling update).
- **Service** = the pass window. Waiters hand orders to "the kitchen", never to
  a cook by name. Whoever is at the pass gets orders.
- **Readiness probe** = a cook is not put at the pass until they have read
  today's menu (`/readyz`: database up, migrations applied). Not ready means
  no orders, not "fired".
- **Liveness probe** = a cook who has frozen mid-sentence is sent home and
  replaced (`/healthz`). A cook who is merely waiting for the delivery van is
  *not* frozen, which is why `/healthz` does not look at the database.
- **preStop sleep** = when a cook's shift ends, the manager first tells the
  waiters "stop handing orders to Sam", then waits a moment for every waiter
  to hear it, and *then* lets Sam take off the apron. Without the wait, a waiter
  who did not hear yet hands Sam an order that nobody cooks.
- **HPA** = tickets pile up, call in two more cooks; the rush ends, let them go
  one at a time, not all at once (the rush might come back).
- **PDB** = the fire marshal wants to clear the kitchen for an inspection (a
  node drain); he may take cooks one at a time but never the last one.
- **NetworkPolicy** = only the head chef (Prometheus) may read a cook's
  timesheet (`/metrics`). Customers (port 3000) are welcome.
- **migrate Job** = before the first service, someone sets the menu and
  checks the stock room. Cooks that arrive early stand by (not ready) until
  it is done.

---

## 3. Every setting, and why it is there

### Pods start on their own schedule; readiness is the ordering

There is no "start A after B" in Kubernetes. Everything is applied at once.
What makes it work:

- **The migrate Job** runs the roles script and the migrations. It is the only
  thing that *writes* the schema.
- **api and worker pods start right away** but are not *Ready*: `/readyz`
  answers 503 while the database is unreachable or any migration file is
  unapplied (step 6a). The Service sends traffic only to Ready pods. So the
  moment the Job finishes, `/readyz` turns 200 by itself and traffic begins.
- **The workers additionally wait** (`waitUntilReady`, `src/readiness.ts`)
  before taking their first row. They have no inbound traffic for readiness
  to gate, and a worker that polled before the tables existed used to crash on
  its first query and restart until migrations landed. Now it logs one line
  per check and waits.
- **A worker survives the database going away** (`Worker.loop`,
  `src/worker/run.ts`): a connection timeout or a dropped socket while
  claiming a row is logged and the loop polls again after its interval; the
  claim ran in a transaction, so nothing was lost. Before 6b that error
  escaped the loop and ended the process (test 11). The connection pool also
  logs, rather than crashes on, an idle connection dying (test 10).

### The migrate Job is deleted and recreated on every deploy

A Job's pod template is **immutable**: `kubectl apply` of the same Job with a
new image tag is rejected ("field is immutable"). Two ways around that:

1. **Delete + recreate** (chosen; `scripts/k8s/deploy.sh`): fixed name
   `migrate`, static manifests, `kubectl wait job/migrate` has a stable target,
   and the last run's logs stay until the next deploy replaces them.
2. **Unique names + `ttlSecondsAfterFinished`**: a per-deploy name has to be
   injected into the manifests at deploy time (kustomize `nameSuffix` edited
   by the pipeline), every wait has to learn the name, and the TTL stops old
   Jobs piling up. More moving parts for the same result.

6c's deploy pipeline reuses `deploy.sh`, so it inherits option 1.

### api: `replicas: 2`, `maxUnavailable: 0`, `maxSurge: 1`

During a rollout there are never fewer than 2 Ready api pods: a third (new)
pod is started, becomes Ready, and only then is an old one terminated. The
cost is one pod's worth of resources during the rollout. With
`maxUnavailable: 1` instead, Kubernetes could terminate an old pod *first*,
and for a moment one pod would carry all traffic.

### The three probes

| Probe | Path | Period | Fails after | Effect of failing |
|---|---|---|---|---|
| startup | `/healthz` | 2 s | 60 tries (2 min) | container restarted. Until it passes, the other two do not run, so a slow start is never mistaken for a hang |
| readiness | `/readyz` | 5 s | 2 tries | pod removed from the Service; nothing restarted |
| liveness | `/healthz` | 10 s | 6 tries (1 min) | container restarted |

Every probe has an explicit `timeoutSeconds` (3 s for the Node processes,
5–10 s for Postgres, Prometheus, Grafana). **The default is 1 s**, and on the
first cold start a busy node took longer than that to answer for healthy
processes; a timed-out probe counts as failed, and enough failed liveness
probes restart a process that was fine. Section 8 has the story, and the
reason liveness tolerates a full minute.

Postgres' liveness probe is a **TCP** check, not `pg_isready`. An exec probe
needs the container runtime to start a process inside the container within
the timeout, and on a saturated node that is the first thing to fail
(`ExecSync ... timeout 5s exceeded` in the kubelet log), which restarts the
one process everything depends on. "Port 5432 accepts connections" is
checked by the kubelet itself and still catches a dead or hung postmaster.
Readiness keeps `pg_isready`: failing it only removes the pod from the
Service, which is the right reaction to "cannot tell".

### Graceful shutdown: `terminationGracePeriodSeconds: 40` = 5 + 25 + margin

When a pod is deleted, Kubernetes does two things **at the same moment**: it
removes the pod from the Service's endpoints, and it starts terminating the
container. The first is asynchronous: every node's routing rules (kube-proxy)
learn about it a little later. If the container stopped accepting
immediately, requests that were already routed to it would fail.

So the api's container has `preStop: sleep 5` (Kubernetes' built-in sleep
action, no shell needed in the image). Order of events:

1. `deletionTimestamp` set; endpoint removal begins; preStop runs: **sleep 5 s**
2. SIGTERM. The app flips `/readyz` to 503, stops accepting, finishes in-flight
   requests (`SHUTDOWN_GRACE_MS` = 25 s cap), closes the pool, exits 0
3. if it is still alive after 40 s in total: SIGKILL

The grace period must be *longer* than the app's own drain time, or
Kubernetes kills requests the app was politely finishing. The workers have no
preStop sleep: nothing routes requests *to* a worker, so there is nothing to
wait for; SIGTERM at once, finish the current row, exit.

### Resources: requests and limits on everything

`requests` is what the scheduler reserves and what the HPA's percentage is
relative to; `limits` is the hard ceiling (CPU is throttled, memory is
killed). A pod without requests is scheduled "wherever" and a pod without
limits can take the node down with it. Values are small because this is a
laptop: api 100m/96Mi requested, 500m/256Mi limit; Postgres 192Mi/384Mi.

### HPA: 2 to 4 api pods on CPU

Target: average CPU across api pods at 60 % of the request (60m). Numbers come
from **metrics-server** (vendored in the kind overlay, it is a cluster add-on,
not part of the app). Scale-up reacts at once, at most 2 pods per 30 s.
Scale-down waits until the load has been low for 5 minutes in the base
(60 s in the kind overlay so the demo ends in minutes): scaling up is cheap,
scaling down too early and having to scale up again means slow requests in
between.

Known wrinkle: the Deployment also says `replicas: 2`. Every `kubectl apply`
re-applies that number, so a deploy during a busy period momentarily sets 2
and the HPA scales back up. The usual production answer is to omit
`replicas` from the Deployment once an HPA owns it.

### PDB: `minAvailable: 1`

For *voluntary* disruptions only: a node being drained for an upgrade, the
cluster autoscaler removing a node. The drain evicts pods one at a time and
waits rather than evicting the last api pod. It cannot help with crashes or
a node dying, and on a one-node kind cluster there is nothing to drain; it is
here because 6c's cluster will have more than one node.

### Security: non-root, read-only, no capabilities, no escalation

Every container: `runAsNonRoot` with the image's own user (node 1000,
postgres 999, grafana 472, prometheus 65534, k6 12345),
`readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`,
`capabilities: drop ALL`, seccomp `RuntimeDefault`. Where a process must
write, it gets a small `emptyDir`: Postgres' socket directory and `/tmp`,
Prometheus' data, Grafana's own database, the reconcile report in `/tmp`.
The api, workers and mock provider write nothing at all.

The `ledger` namespace carries `pod-security.kubernetes.io/enforce: restricted`:
the cluster **rejects** any pod in it that does not meet the above, so nobody
can add one that does not.

### The metrics port is a different port

With `METRICS_PORT` set (step 6b's small code change), the api serves
`/metrics` only on port 9100. The public Service `api` exposes 3000 only; a
headless Service `api-metrics` exposes 9100 for Prometheus; and a
NetworkPolicy allows 9100 (and the workers' 9101) **only from the Prometheus
pod**. Metrics reveal internals (routes, error rates, memory); an ingress in
front of the public Service never sees them. `smoke.sh` proves the policy by
trying from a pod that is not Prometheus (kind's network plugin, kindnet,
enforces NetworkPolicies).

### Headless Services + `publishNotReadyAddresses`

Prometheus must scrape *every* api pod, not "an" api pod through a
load balancer (that would mix the counters of random pods). The headless
Service `api-metrics` gives one DNS A record per pod; Prometheus'
`dns_sd_configs` asks DNS every 15 s and scrapes each address. No
cluster-wide read permissions needed. `publishNotReadyAddresses: true` keeps
pods that fail readiness in that DNS answer: a sick pod is exactly the one
whose metrics you want.

### ConfigMaps with a hash in the name

`configMapGenerator` turns files (the roles SQL, `prometheus.yml`, the
Grafana dashboard) into ConfigMaps named `prometheus-config-<hash of the
content>`, and rewrites every reference to use that name. Change the file and
the Deployment's pod template changes, so the pods **roll**. A config change
deploys like a code change, never a silent edit of a running pod.

### mock-provider uses `strategy: Recreate`

Its payments live in memory. A rolling update would briefly run two copies
with different memories, and a payment created on one could not be found on
the other. The real provider is outside the cluster; this Deployment exists
only locally.

### CronJob: `timeZone: Asia/Kolkata`, `backoffLimit: 0`, `ttlSecondsAfterFinished`

`timeZone` makes "02:00" mean 02:00 in India rather than 02:00 UTC on the
node. `backoffLimit: 0`: the reconcile process exits 1 when it **finds
problems**, which is a correct answer, not a transient error; retrying a
minute later would find the same problems. A run with problems therefore
shows as a failed Job, and the worker's `reconciliation_last_run_ok` gauge
turns red. `concurrencyPolicy: Forbid` never overlaps two runs. One-off runs
(`scripts/k8s/reconcile-now.sh` = `kubectl create job --from=cronjob/reconcile`)
are not covered by the CronJob's history limits, so the template's TTL cleans
them up after a day.

### Postgres as a StatefulSet, and why not in production

The StatefulSet gives the database a stable name and a disk that follows the
pod across restarts (the PVC survived the StatefulSet roll in this step: the
schema and data were there afterwards). That is the right shape for running
a database on Kubernetes, and still the wrong place for production money
data. A **managed database** (RDS, Cloud SQL, Oracle Autonomous Database...)
gives tested backups and point-in-time recovery, a standby with automatic
failover, storage that grows, minor-version patching, and an on-call team for
the database itself. Doing all of that on a cluster is a full-time job that is
not this service's job, and getting one piece of it wrong loses money.

### Secrets: generated from `.env`, never committed

`scripts/k8s/secrets.sh` reads the local `.env`, takes the passwords out of
its URLs, rebuilds the URLs with the in-cluster host `postgres`, and creates
two Secrets with `kubectl create ... --dry-run | kubectl apply` (idempotent;
the values never touch the disk). The migrate Job's init container then sets
each role's password from the Secret (`ALTER ROLE ... PASSWORD :'var'`, psql's
safe quoting), so the local defaults in `00-roles.sql` are overwritten at
once. CI checks that no `kind: Secret` is tracked in git.

---

## 4. The layout: base and overlays

```
k8s/base/                 everything, environment-independent
  overlays/kind/          image tag "local", 1 events worker, fast HPA scale-down,
                          metrics-server with --kubelet-insecure-tls, the kind cluster config
  overlays/oracle/        (step 6c)
  tools/                  seed Job, k6 Job: on demand, not part of a deploy
```

The rule: **nothing kind-specific in base**. kind needs four things a real
cluster does not: image tags that exist only on this machine, fewer replicas
for memory, metrics-server trusting self-signed kubelet certificates, and
etcd keeping its data in memory (`cluster.yaml`: the node's `/tmp` is tmpfs,
so etcd never waits on the laptop's disk; section 8 says why that mattered).
Those are the overlay. Two files moved under `k8s/` so that kustomize (which
only reads files below its own directory) and Compose share one copy: the
Grafana dashboard and the roles SQL.

---

## 5. Expected and measured memory

Estimate before starting, measured after `up.sh` (Docker VM: 3.8 GiB, 8 CPUs):

| | estimate (steady) | measured (`kubectl top`, idle after smoke) |
|---|---|---|
| Kubernetes itself (API server, etcd, controllers, kubelet, CoreDNS, kindnet, metrics-server) | ~600 MB | node container **603 MiB** right after `kind create cluster`, before anything was deployed |
| postgres | ~100 MB | 40–93 MiB |
| api × 2 | ~120 MB | 27–32 MiB each |
| worker-commands + worker-events | ~100 MB | 23–26 MiB each |
| mock-provider | ~20 MB | 14–15 MiB |
| prometheus | ~100 MB | 36–48 MiB |
| grafana | ~100 MB | 179–208 MiB (the one I underestimated) |
| **whole node container** (`docker stats`, includes the page cache of the imported images) | **~1.2–1.4 GB** | **1.48–1.58 GiB** idle; 1.9 GiB during the first cold start |

The Node processes are smaller than estimated (the image is Alpine, the heap
is tiny), Grafana is twice the estimate, and the node total is above the
estimate mostly because `docker stats` counts the page cache of the 2 GB of
image layers imported into the node. Well inside the 3.8 GiB VM either way;
the VM reported 2 GB *available* throughout.

---

## 6. Zero-downtime deploy: the test and the result

**Set-up.** k6 runs *inside the cluster* as a Job, against `http://api:3000`,
at 10 virtual users for 3 minutes (transfers with 10 % idempotent retries,
plus one top-up per second through the worker, provider and webhook). Not
through a port-forward: a port-forward pins every request to one pod and
would fail the moment that pod is replaced, proving nothing about the
Service. After 45 s of warm-up, `kubectl rollout restart deployment/api`
replaces every api pod, as a new image would. Meanwhile the script records
each old pod's `deletionTimestamp` and follows its log.

**Result** (`VUS=3 scripts/k8s/zero-downtime.sh`, fresh cluster, Mac on AC):

```
requests: 2749   failed: 0   replay mismatches: 0   checks ok: 99.9 %
rollout took 125 s (4 pods: the HPA had already scaled up under the warm-up)
```

The two failed checks are "provider confirms" on two top-ups whose
confirmation took longer than k6's 5 s poll (the provider did confirm them;
the ledger posted them). No request got an error or a dropped connection.

The pod timeline, one line per change (`load/out/k8s-zero-downtime/timeline.txt`):

```
20:23:37  NEW mkgdq=not-ready   old 4xvq9 65s46 8ktb4 t5qt2 = ready        new pod starts
20:24:23  NEW mkgdq=ready       old 4 still ready                           it passed /readyz ...
20:24:25  NEW js6n7=not-ready   old 65s46=terminating                       ... and only now is one old pod told to go
20:24:46  NEW js6n7=ready
20:24:47  NEW nswrf=not-ready   old 4xvq9=terminating
20:25:10  NEW nswrf=ready
20:25:11  NEW 8sx94=not-ready   old t5qt2=terminating
20:25:34  NEW 8sx94=ready       old 8ktb4=terminating
20:25:50  4 new pods ready, no old pods
```

At no moment were there fewer than four Ready pods: `maxSurge: 1` adds the
fifth, `maxUnavailable: 0` forbids removing one before its replacement is
Ready. Each replacement takes ~45 s because the new pod must pass its startup
probe and then two readiness probes 5 s apart.

Per replaced pod, from its own log and its `deletionTimestamp`
(Kubernetes writes that field as *request time + grace period*, so the script
subtracts the 40 s):

```
api-...-4xvq9: SIGTERM 6.4 s after deletion began, drained in 1.11 s
api-...-65s46: SIGTERM 6.3 s after deletion began, drained in 0.35 s
api-...-t5qt2: SIGTERM 5.8 s after deletion began, drained in 0.52 s
api-...-8ktb4: SIGTERM 7.4 s after deletion began (its last log line was cut mid-write; timestamp recovered by hand)
```

6–7 s ≈ the 5 s preStop sleep plus the kubelet's own overhead: that is the
`sleep` lifecycle action working on the pinned 1.37 node, measured rather
than assumed. "Drained in" is `shutdown started` → `shutdown complete` in the
app's log: under 3 VUs there was little in flight, so the app was out well
within its 25 s budget, and far within the 40 s grace period.

Latency during the run was poor (p95 1.7 s, p99 6.2 s, max 25 s): a rolling
update of four Node processes on a laptop that also runs Postgres, the
workers, Prometheus, Grafana, k6 and a Kubernetes control plane. Slow is
not the same as failed; nothing failed.

**Why it is zero.** Four things line up: `maxUnavailable: 0` means a new,
Ready pod exists before an old one goes; the preStop sleep gives the
endpoint removal 5 s to reach kube-proxy before the old pod stops accepting;
the app's own shutdown then drains in-flight requests before exiting; and
the readiness probe keeps a new pod out of the Service until it has
answered `/readyz` with 200. Take away any one of them and some requests fail.

---

## 7. HPA demo

`scripts/k8s/hpa-demo.sh` with 20 virtual users for 3 minutes (the kind overlay's
60 s scale-down window; the base waits 5 minutes). One line every ~10 s:

```
time      load  cpu/target  desired  ready
01:22:14  on     12%/60%    2        2      load starts
01:22:46  on     16%/60%    2        2      metrics-server has not seen it yet (15 s resolution)
01:22:57  on    308%/60%    4        4      first reading above target: straight to the maximum
01:23:30  on    337%/60%    4        4
01:25:28  on    170%/60%    4        4
01:25:40  off    94%/60%    4        4      load stops
01:26:13  off    28%/60%    4        4
01:27:04  off   116%/60%    4        4      a bump: the workers drain the notification backlog, top-ups post
01:28:54  off    17%/60%    4        4
01:31:05  off    16%/60%    3        4      60 s continuously below target: one pod removed ...
01:31:36  off    16%/60%    2        2      ... and 30 s later the next. Back to the minimum.
```

Up: 2 → 4 within 45 s of the load starting (the HPA computes
`ceil(2 × 308/60) = 11`, capped at 4). Down: 2 → 4 → 3 → 2, but only once the
CPU had stayed below target for the whole 60 s window; the post-load bumps
reset that window, which is exactly the "do not flap" behaviour the window
exists for.

k6 during the demo: **24,654 requests, 0 failed**, 100 % of checks passed,
p95 575 ms, p99 1.4 s (the `p(95)<500ms` threshold from step 6a is crossed:
four api pods, Postgres, the workers, Prometheus, Grafana, k6 and the
Kubernetes control plane all share one laptop's Docker VM).

---

## 8. What went wrong the first time, and what it taught

The very first `up.sh` ended with every pod Running and **17 restarts between
them**: grafana 5, each worker 4, prometheus 3, one api pod 2, mock-provider
1, and even kube-scheduler and kube-controller-manager had restarted. Nothing
was broken; the node was saturated for about four minutes (2 GB of images
being imported, Grafana running its first-start migrations, everything
starting at once), and three of my defaults did not survive that:

1. **1-second probe timeouts** (the default). Healthy processes took longer
   than 1 s to answer; a timeout is a failure; three failures is a restart.
   Fix: explicit `timeoutSeconds` on every probe.
2. **60-second startup budget.** Under that load one api container took longer
   than 60 s just to start, so the startup probe killed it, twice. Fix:
   startup probes allow 2 minutes. They are free to be generous; liveness
   stays tight.
3. **Workers crashed before migrations.** Expected on paper (the Job and the
   workers start together), but "crash, restart, crash" is not a plan. Fix:
   the worker waits for readiness (test 9).

The second deploy, after the fixes: every pod Ready in 25 s, zero restarts.
Lesson underneath all three: **a restart is a decision Kubernetes makes on
your behalf, with your numbers.** Numbers you did not choose are still your
numbers.

**A second storm, later, with a different cause.** About forty minutes after
that clean deploy, while the cluster was idle, every pod restarted twice
within three minutes, and so did the API server, scheduler and
controller-manager. The node container never restarted, containerd and the
kubelet never restarted, there was no OOM and 2 GB of memory was free. The
kubelet log shows what happened: from 19:06:47 UTC every *exec* probe
(`pg_isready`, 5 s timeout) timed out and the kubelet could not even update
the node's status: the whole node had **stalled** for about half a minute.
Liveness probes count a timeout as a failure; three failures 10 s apart is
30 s; at 19:07:10 the kubelet started stopping containers, healthy ones
included (Postgres and Prometheus exited 0: they were simply told to stop).
The trigger was on the host (the Mac was on battery with Low Power Mode on
during this session, which throttles the whole Docker VM; I cannot prove that
was it). The lesson is one every operator eventually learns the hard way:
**liveness probes turn a node stall into a restart storm.** They should be
generous (long periods, several failures, explicit timeouts) because the
thing they protect against, a hung process, is rare, and the thing they
cause, restarting healthy processes under load, is not. Ours now tolerate a
60 s stall (6 × 10 s); anything longer restarts everything, and that is the
trade-off chosen here rather than an accident.

**A third storm, under load, found the real weak points.** Running the
zero-downtime test (section 6) and the HPA demo (section 7) back to back
brought the control plane down three times at the same moment: the rolling
update, with k6 running. etcd logged `apply request took too long: 6.0s
(expected 100ms)`, the API server failed its liveness probe and was killed
(exit 137), the scheduler and controller-manager lost their leader-election
leases and went into five-minute CrashLoopBackOff, and the rollout froze
half-way because the controller that drives it was gone. Then, with the load
removed, the cluster kept restarting things for ten more minutes: Postgres
nine times, because its *exec* liveness probe could not get a process
started inside the container while containerd was busy; every Postgres
restart broke the workers' connections, and the worker loop had no
try/catch around a connection timeout, so they crashed too. Four changes
came out of it, each of which would be right on a real cluster as well:

1. Postgres liveness is a TCP probe (section 3).
2. Liveness probes tolerate 60 s, not 30 s.
3. The worker loop survives a transient database error (tests 10 and 11).
4. On kind only, etcd's data lives in memory, so the control plane never
   waits on the laptop's disk.

Also learned: a load script that dies must delete its k6 Job, or 40 virtual
users keep hammering a cluster whose control plane is already down (both
scripts now do that on exit).

**What the fixes do and do not do.** After them, the fresh cluster came up
with zero restarts, the smoke test passed, the rollout test failed zero
requests, and the control plane never went down again. But a later deploy
that rolled Grafana still restarted one api pod and the events worker: their
`/healthz` went unanswered for 60 s straight, which means the VM itself
stalled for a minute (this Mac has 8 GB, Docker gets 3.8 GiB, and the node
sat at 2.1 GiB). The worker's log for that minute shows the fix working:
four `connection timeout` errors logged, no crash, `stopped cleanly` on the
SIGTERM. The manifests make the system *survive* a stalled machine; they
cannot make the machine faster. 6c runs on a cluster with its own CPUs.

---

## 9. CI without a cluster

`k8s-validate` renders base and every overlay with `kubectl kustomize` (bad
references, missing files and malformed patches fail here) and runs
`kubeconform -strict` against the Kubernetes 1.33 API schemas, so a typo in a
field name is an error rather than something the API server silently ignores.
kubeconform is a pinned release with a verified checksum. A tracked
`kind: Secret` fails the job too.

---

## 10. Known gaps

- One node: the PDB and node-level scheduling cannot be exercised; 6c has them.
- Prometheus data is an `emptyDir` (6 h retention, gone with the pod); Grafana
  is anonymous-read. Fine locally, not for a shared cluster.
- No ingress or TLS: traffic enters through `kubectl port-forward`. 6c adds a
  real entry point.
- `replicas: 2` on the api Deployment next to the HPA (section 3).
- The database runs in the cluster (section 3, Postgres).

---

## 11. Questions

1. The migrate Job and the api pods are applied at the same instant. Walk
   through what each api pod does during the ~10 s before the Job completes,
   and what a user calling `/transfers` through the Service sees.
2. `terminationGracePeriodSeconds` is 40 and `SHUTDOWN_GRACE_MS` is 25 000.
   What exactly happens to a request that is still waiting on a row lock at
   second 31 after SIGTERM? And at second 41?
3. If the preStop sleep were removed, which requests would fail during a
   rollout, and why would `maxUnavailable: 0` not save them?
4. The readiness probe fails after 2 misses at 5 s each. A pod's database
   connection pool is exhausted for 12 s. What does the Service do, what does
   the HPA do, and what does nothing do?
5. Why does the NetworkPolicy for the api list port 3000 at all, when the
   intent was only "metrics from Prometheus"?
6. Change `prometheus.yml`. Describe, step by step, how the running Prometheus
   pod ends up with the new file, and why it is a new pod.
7. `backoffLimit: 0` on the reconcile CronJob versus `backoffLimit: 3` on the
   migrate Job: what is different about the two failures that justifies the
   two numbers?
8. The HPA scaled to 3 replicas during the first deploy, with no users at
   all. Where did the CPU come from, and would the base's 5-minute scale-down
   window have made that better or worse?
