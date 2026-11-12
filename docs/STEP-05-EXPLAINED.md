# Step 5, explained: the outbox, the worker, and reconciliation

Step 5 moves every side effect out of the request path and into a queue that lives in
the database, adds the worker that drains it, and adds the job that answers "are the
books right, right now?". Read this next to `src/outbox/enqueue.ts`, `src/worker/` and
`src/reconcile/`.

---

## 1. The dual-write problem

A transfer is posted. Something else must now happen: an email, a push to analytics, a
call to the payment provider. Where does that call go?

**Inside the database transaction** (what step 4 did for the provider):
- if the call hangs, the transaction hangs: a connection and the row locks are held for
  as long as the network takes
- if the call succeeds and then COMMIT fails, the outside world has acted on something
  that never happened ("notified but never saved")

**After the transaction**:
- if the process crashes between COMMIT and the call, the change exists and nobody will
  ever hear about it ("saved but never notified")
- there is no record that the call was owed, so nothing can retry it

Two systems, one logical action, and no way to make both happen or neither. That is the
dual-write problem, and no amount of ordering fixes it, because a crash can land between
any two statements.

### The analogy: the shop's outgoing-post tray

The khata shopkeeper never walks to the post office in the middle of writing an entry.
They finish the entry, and in the same motion drop a note into the **outgoing-post tray**:
"tell the wholesaler we paid". The tray is part of the shop; if the shop burns down, the
entry and the note burn together. Later, the delivery boy empties the tray. If he's hit by
a bicycle on the way, the notes are still in his bag and someone else delivers them, maybe
twice, which is why every note carries a number and the wholesaler ignores a number he has
already seen.

The tray is the `outbox` table. The delivery boy is the worker. The number is the outbox
row id.

---

## 2. The outbox pattern

```
BEGIN
  … the ledger change (entries, balances, status) …
  INSERT INTO outbox (type, payload)          ← same transaction
COMMIT                                         ← both exist, or neither

            worker, later, in its own transaction:
            SELECT … FOR UPDATE SKIP LOCKED LIMIT 1
            perform the side effect
            UPDATE outbox SET status = 'sent'
            COMMIT
```

Three facts:

1. **Writing the intent is a local write.** `enqueueOutbox()` is one INSERT on the same
   client as the ledger change. The transaction's atomicity, which we already trust for
   money, now also covers "this side effect is owed". Test 1: a rolled-back transfer leaves
   no outbox row; a committed one always does.
2. **The side effect runs outside any ledger transaction.** The worker holds a lock on one
   outbox row and nothing else. A slow provider delays one row, not a request, not a user.
3. **At-least-once, never at-most-once.** If the worker crashes after the call and before
   `status = 'sent'`, the row is still pending and will be retried. The call may happen
   twice. So every side effect must be safe to repeat, and every receiver must dedupe.

### Where the rows come from

| Change | Outbox row | Who performs it |
|---|---|---|
| `POST /transfers` posts a transfer | `transfer.posted` | worker → notification sink |
| `POST /topups` records a pending top-up | `provider.create_payment` | worker → provider, then records the paymentId |
| webhook posts a top-up | `topup.posted` | worker → notification sink |
| webhook fails a top-up | `topup.failed` | worker → notification sink |

The top-up flow is the big change: **the request no longer talks to the provider.** It
writes the pending transaction, a `topups` row *without* a paymentId, and the command, and
answers 202 in a few milliseconds. The step 4 explainer called this out as a trade-off to
fix; this is the fix.

### Making the repeat harmless

- **Provider call:** the worker sends `Idempotency-Key: <topupId>`. The mock provider
  (and any real one) returns the same payment for the same key. Test 3 kills the worker
  right after the call and checks that the retry leaves exactly one payment.
- **Recording the paymentId:** `topups.provider_payment_id` may be set exactly once, from
  NULL, by the worker, and nothing else about the row can ever change (migration 005
  replaces the trigger function in place; `db-guarantees` 26).
- **Notifications:** every event carries its outbox id; the sink dedupes on it (test 7).
- **Webhooks before the paymentId exists:** the provider may confirm a payment before the
  worker's retry has recorded its id. The webhook therefore also matches by `reference`
  (our top-up id) when the top-up has no paymentId yet (test 6). A reference pointing at a
  top-up that already belongs to a *different* payment is recorded as `unmatched`.

---

## 3. `SELECT … FOR UPDATE SKIP LOCKED`

Several workers may run at once. Each wants a row nobody else is working on.

- `FOR UPDATE` locks the chosen row until the worker's COMMIT.
- `SKIP LOCKED` makes the query **skip** rows other transactions hold instead of waiting
  for them. Worker B's query simply doesn't see the row worker A holds, and takes the next.

So N workers drain the same queue without coordination, without a dispatcher, and without
ever processing a row twice at the same time (test 4). A crashed worker's lock disappears
with its connection, and its row becomes visible to the others again.

### One row per transaction

Each outbox row is processed in its **own** transaction: claim, handle, mark, COMMIT, next.
A crash repeats at most one side effect, and no transaction stays open across many network
calls, which is the exact problem we just removed from `POST /topups`. SIGTERM finishes
the row in progress, takes no new row, and exits 0 (test 8).

### The production-scale alternative: leasing (not built here)

Holding a row lock while calling the network ties a database connection to every
in-flight side effect. At thousands of concurrent calls that's thousands of connections.
The usual answer is **leasing**:

```
UPDATE outbox SET status = 'processing', locked_until = now() + interval '30 s'
 WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *;   COMMIT
… perform the side effect with NO transaction open …
UPDATE outbox SET status = 'sent' WHERE id = $1;                        COMMIT
```

A worker that dies mid-call leaves a `processing` row whose `locked_until` passes; the
poll query treats expired leases as pending again. Costs: a third status, a lease
duration to tune (too short and a slow-but-alive call gets duplicated, too long and a
dead worker's row waits), and the guarantee weakens from "at most one worker at a time"
to "at most one worker per lease window". Right for a fleet; unnecessary for us today.

---

## 4. Backoff, jitter, dead letters

A failing side effect is retried with growing delays: `min(1 s × 2^attempts, 5 min)`,
multiplied by a random factor in [0.5, 1.5).

- **Exponential**: a provider that is down for an hour gets a handful of calls, not a
  thousand.
- **Jitter**: a thousand rows that failed at the same instant (the provider blipped) would
  otherwise retry at the same instant and knock it over again. Random spread turns the
  stampede into a trickle.
- **`available_at`**: the delay is stored on the row, not kept in memory, so a restarted
  worker honours it.
- **`last_error`**: the most recent reason, always visible.
- **Dead after N attempts** (8 by default): the row's status becomes `dead`, it is never
  picked up again, and it is never deleted. Reconciliation lists it. "Give up quietly" is
  not an option the schema allows: a dead row must carry its error (CHECK), and once dead it
  is frozen (trigger). Test 5 walks a row through two retries into the grave.

---

## 5. Reconciliation

Every guarantee so far is enforced at write time. Reconciliation asks, after the fact and
from the data alone, whether the invariants still hold. `npm run reconcile` connects as
`ledger_reconciler` (SELECT on what it checks, INSERT on `reconciliation_runs`, nothing
else) and runs five read-only checks:

| Check | Question | What it catches |
|---|---|---|
| `account_balances` | cached `balance_paise` = credits − debits? | the "known gap" from step 1: a wrong balance write (test 9) |
| `posted_transactions_balanced` | every posted transaction has ≥ 2 entries and debits = credits per currency? | corruption that bypassed the triggers (test 10 disables them to simulate it) |
| `stale_pending_topups` | pending top-ups older than 24 h? | a provider that never answered, a lost webhook |
| `webhook_anomalies` | `anomaly_amount_mismatch` / `unmatched` events? | the investigation queue from step 4 |
| `outbox_problems` | dead rows, or pending for > 60 min? | side effects that are not happening |

It prints a report, writes it as JSON, inserts **one** `reconciliation_runs` row (append-only;
`ok` must equal "zero problems", by CHECK), and exits 1 if anything is wrong. A CronJob
runs it in step 6. The answer to "how do you know your balances are correct right now?" is:
the last run said so, and here is the row.

---

## 6. Roles after step 5

| Role | Can | Cannot |
|---|---|---|
| `ledger_app` | everything from steps 1–4, plus `INSERT (type, payload)` on `outbox` | see or mark outbox rows; set a paymentId |
| `ledger_worker` | `SELECT` outbox; `UPDATE` its bookkeeping columns; `SELECT` topups; `UPDATE (provider_payment_id)` topups | create outbox rows; read or touch accounts/entries; anything on reconciliation_runs |
| `ledger_reconciler` | `SELECT` on everything it checks; `INSERT` on reconciliation_runs | any UPDATE or DELETE anywhere |
| `ledger_owner` | migrations, test resets | nothing stops the owner except the triggers |

`db-guarantees` 24 proves each role is refused the others' work. The roles live in
`db/init/00-roles.sql`, which is now safe to re-run (`npm run db:roles`).

---

## 7. Every new rule and the bug it prevents

| Rule | Bug |
|---|---|
| outbox row written in the same transaction as the change | saved-but-never-notified, notified-but-never-saved (test 1) |
| `POST /topups` only queues the provider call | a hanging provider pinning a connection and the idempotency key (test 2) |
| `Idempotency-Key = topupId` on the provider call | two payments for one top-up after a crash (test 3) |
| `FOR UPDATE SKIP LOCKED`, one row per transaction | two workers doing the same side effect at once (test 4) |
| attempts / `available_at` / `last_error` / `dead` | an endless hot retry loop, or a failure vanishing (test 5) |
| webhook matches by reference too | a confirmation that races the worker being `unmatched` (test 6) |
| outbox id on every event | a redelivery acted on twice downstream (test 7) |
| SIGTERM finishes the current row | a deploy cutting a side effect in half (test 8) |
| provider/sink calls time out at 3 s | one hung call stalling the queue (test 9) |
| `topups.provider_payment_id` set once, by the worker | a second recording overwriting the first (db 26) |
| outbox frozen once final, attempts never decrease | a bug resurrecting a sent row or hiding failures (db 25) |
| `ledger_app` cannot read/mark outbox; `ledger_worker` cannot touch the ledger; `ledger_reconciler` cannot write | a compromised API draining the queue; a worker bug moving money (db 24) |
| `reconciliation_runs.ok = (problems = [])` | a run that says OK while listing problems (db 27) |

---

## 8. Eight questions to answer before moving on

1. Name the two orderings of "COMMIT" and "call the provider" and the failure each one allows. Why does putting the call in an outbox row remove both?
2. A worker crashes after `provider.createPayment` returns and before its transaction commits. List the state of: the outbox row, `topups.provider_payment_id`, the provider's records. What makes the retry produce one payment, not two?
3. Two workers poll at the same instant with 10 pending rows. Explain what `SKIP LOCKED` changes compared with plain `FOR UPDATE`, and what happens to a row whose worker dies mid-handler.
4. Why does the worker process one row per transaction instead of a batch? What would a batch of 10 cost after a crash on row 7?
5. Describe the leasing design and the one guarantee it gives up compared with holding the row lock.
6. Why is jitter necessary even with exponential backoff? Draw what 1,000 failed rows do with and without it.
7. The reconciler finds an account whose cached balance is off by one paise. Which of the four roles could have caused that, which could not, and why doesn't a trigger prevent it?
8. A webhook arrives for a payment whose `reference` is a top-up that already has a *different* `provider_payment_id`. What does the ledger do, and what two things could explain the situation?
