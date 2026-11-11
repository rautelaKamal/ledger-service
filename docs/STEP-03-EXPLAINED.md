# Step 3, explained: `POST /transfers` with idempotency keys

Step 3 puts `transfer()` behind HTTP and makes retries safe. Read this next to
`src/idempotency.ts` and `src/http/transfers.ts`.

---

## 1. The problem: a retry is a second request

A client sends `POST /transfers` for ₹100. The server moves the money, writes the
response, and then the network drops before the response reaches the client. From the
client's side, the request *failed*: no answer. Any sensible client retries. The server
sees a brand-new request for ₹100 and moves it again. Nothing was wrong with either
request; the money still moved twice.

The fix is a contract between client and server:

- The client puts a unique `Idempotency-Key` on each **intended** operation, and reuses
  the same key on every retry of it.
- The server remembers what it answered under each key. A retry gets the **first** answer
  back, and nothing happens again.

### The analogy: the token at the counter

At a busy counter, you take a numbered token before you're served. If the power cuts out
and you come back, you don't take a new token; you show the old one. The clerk looks at
the token number, sees "already paid out ₹100 at 10:42" written against it, and says
"here's your receipt again." If someone else shows up with the *same* number while your
payout is still being counted, the clerk tells them to wait until it's done, and then
shows them the same receipt. If a stranger shows up with your token number but asks for a
different amount, the clerk refuses: that token is already for something else.

`idempotency_keys` is the clerk's token book. The token number is `(client_id, key)`, the
"what was asked" is `request_hash`, and the receipt is `response_status` + `response_body`.

---

## 2. The key row is the lock

The whole request runs in **one database transaction**:

```
BEGIN
SET LOCAL lock_timeout = '5s'
INSERT INTO idempotency_keys (client_id, key, request_hash) … ON CONFLICT DO NOTHING
  ├─ 1 row inserted  → the key is ours, continue
  └─ 0 rows          → someone already finished it: read their row
                        ├─ expired?            → delete it, claim again
                        ├─ different hash?     → ROLLBACK, 422
                        └─ same hash           → ROLLBACK, replay stored response (Idempotent-Replayed: true)
SAVEPOINT before_work
transferWithClient(client, …)
  ├─ success          → RELEASE SAVEPOINT
  └─ business error   → ROLLBACK TO SAVEPOINT (drop its writes, keep the key)
UPDATE idempotency_keys SET response_status, response_body, transaction_id
COMMIT
```

Three facts make this airtight:

1. **One transaction.** The key row, the transfer's rows and the stored response become
   visible at the same instant (COMMIT) or never. There is no window where money moved
   but the key wasn't saved, or the key says "done" but money didn't move.
2. **The primary key `(client_id, key)` is a lock.** If two requests insert the same key
   at the same time, Postgres makes the second `INSERT` **wait** until the first
   transaction commits or rolls back. If the first committed, the second gets 0 rows and
   replays. If the first rolled back, the second's insert succeeds and it proceeds as if it
   were first. We never see an "in progress" row: a committed row always has its response.
3. **`ON CONFLICT DO NOTHING`, not a plain `INSERT`.** A plain `INSERT` would wait and then
   throw a unique violation, which aborts our transaction. `DO NOTHING` just reports 0
   rows, so we can read the existing row and act on it.

### Why wait, and when 409

The IETF Idempotency-Key draft allows two answers for "the same key is still being
processed": `409 Conflict` immediately, or wait and replay. We **wait first**. A transfer
takes milliseconds, the wait falls out of the primary key for free, and the client gets its
real answer instead of a "try again" it then has to handle.

But waiting forever is a trap: a stuck first request would pile its duplicates onto
connections until the pool is empty. So the transaction sets `lock_timeout = '5s'`. If the
key (or an account row) isn't free within 5 seconds, Postgres raises `55P03`, and the API
answers **409 with `Retry-After: 1`**. Test 10 proves it by holding a key open in a
transaction and watching a duplicate wait ~5 s and then get 409.

### What is stored, what isn't

| Outcome | Stored under the key? | Why |
|---|---|---|
| 201 created | yes | the answer |
| business error from `transfer()` (400 invalid amount / same account, 404, 422 currency / funds) | **yes** | it's a real answer; a retry must not quietly succeed later (test 5) |
| same key, different fingerprint → 422 | no (the original stays) | the request was refused, not processed |
| malformed request → 400/401 (bad JSON, failed validation, missing headers) | no | there's no well-formed request to fingerprint, and nothing happened |
| unexpected error → 500 | **no** | the whole transaction rolled back; the client should retry (test 6) |
| 409 busy | no | nothing happened; retry |

### The fingerprint

`request_hash = sha256("POST\n/transfers\n" + canonical body)`, where the canonical body is
the **validated** body re-serialised in a fixed field order. So `{"a":…,"b":…}` and
`{"b":…,"a":…}` are the same request, but changing the amount is a different one. The zod
schema is `.strict()`: an unknown field is a 400, never silently dropped, so two requests
can't hash the same while differing in a field we ignored.

---

## 3. Every rule and the bug it prevents

### In the database (migration 003)

| Rule | Bug it prevents |
|---|---|
| `PRIMARY KEY (client_id, key)` | Two requests with one key both running. Also makes keys per-client: client A's "order-1" can't collide with client B's. |
| `request_hash` NOT NULL, 64 hex chars | A key reused for a different operation being replayed as if it were the same. |
| `CHECK ((response_status IS NULL) = (response_body IS NULL))` | A stored status with no body (or vice versa) being replayed as garbage. |
| `expires_at DEFAULT now() + 24h`, app has no INSERT on it | The app (or a client) choosing a key that never expires, or one that expires instantly and lets a retry through. |
| `CHECK (expires_at > created_at)` | A key that is born expired. |
| Trigger `idempotency_keys_frozen_once_stored` | A bug overwriting what a client was already told. Also makes `client_id`, `key`, `request_hash`, `created_at`, `expires_at` immutable. |
| Trigger `idempotency_keys_delete_only_expired` | A buggy cleanup deleting a live key, after which the next retry would transfer again. This is the one way this table can cause a duplicate, so it gets a guardrail. |
| Grants: `INSERT (client_id, key, request_hash)`, `UPDATE (response_status, response_body, transaction_id)`, `DELETE` | The app can't forge timing columns, can't rewrite a request's identity, and may delete, but only what the trigger allows. |
| `transaction_id REFERENCES transactions` | Lets you join a key to the transfer it produced when debugging "did this retry move money?" |

Rows **may** be deleted here, unlike `entries`. They're not ledger history; they're a 24-hour
memory of answers. Same philosophy as before: the grant is the security boundary, the
trigger is the guardrail against bugs.

### In the code (`src/idempotency.ts`, `src/http/transfers.ts`)

| Rule | Bug it prevents |
|---|---|
| Claim the key **before** running the work, in the same transaction | Concurrent duplicates all running the transfer (test 4). |
| `SET LOCAL lock_timeout = '5s'` → 409 | A stuck request exhausting the connection pool through its duplicates (test 10). |
| Business errors returned (not thrown) from the work, then `ROLLBACK TO SAVEPOINT` | A failed transfer leaving half-written rows, while still remembering the answer (test 5). |
| Unexpected errors → `ROLLBACK` everything | A key stored for a request that never completed, blocking all retries forever (test 6). |
| Expired row on conflict → delete and reclaim | A 25-hour-old key replaying a stale answer, or blocking a legitimate new request (test 8). |
| `amountPaise` is a string of digits | An amount passing through a JS `number` and rounding; `1e3`, `1.5`, `-3` all rejected (test 9). |
| `.strict()` body schema | Unknown fields silently dropped before hashing (test 9). |
| `X-Client-Id` required (401) | Keys from different clients colliding. **This header is a stand-in for authentication**; a later step replaces it with real auth and derives the client id from the credential. |

---

## 4. Refactor: `transferWithClient`

`transfer(pool, input)` used to own its transaction. For the key and the transfer to
commit together, the transfer has to run on the **caller's** client, inside the caller's
transaction. So `transfer()` was split:

- `transferWithClient(client, input)`: steps 0 and 2–8, no BEGIN/COMMIT/ROLLBACK. Throws
  on any failure; the caller decides what to roll back to.
- `transfer(pool, input)`: borrows a client, BEGIN, calls `transferWithClient`, COMMIT, and
  the same ROLLBACK/release handling as before.

Behaviour is unchanged; all step 2 tests pass as they were.

---

## 5. Eight questions to answer before moving on

1. Walk through two identical requests arriving at the same instant. At which SQL statement does the second one block, what wakes it, and what does it do next?
2. Why `ON CONFLICT DO NOTHING` instead of a plain `INSERT` followed by catching the unique violation? What state is the transaction in after a unique violation?
3. A transfer fails with insufficient funds. List exactly which rows exist after COMMIT, and explain why the savepoint is needed even though `transferWithClient` throws before writing anything today.
4. Why must a malformed request (zod failure) **not** be stored under its key, while a business error (insufficient funds) **must** be?
5. The first request crashes after the transfer's rows are written but before `UPDATE idempotency_keys`. What does the client see, and what happens on its retry?
6. What would go wrong if the key were claimed in its own short transaction (commit), then the transfer ran in a second transaction?
7. Why is deleting a live idempotency key dangerous enough to deserve a trigger, when deleting an expired one is fine?
8. `lock_timeout` also covers the `FOR UPDATE` on account rows. Describe a situation where a request gets 409 even though no other request used its key.
