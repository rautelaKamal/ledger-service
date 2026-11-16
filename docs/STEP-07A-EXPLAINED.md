# Step 7a, explained: getting the ledger ready for an assistant

Step 7 adds an AI assistant that can answer "what is my balance?", "what
happened on Tuesday?", "explain this transaction". Before any model sees the
ledger, three things have to be true, and this step makes them true:

1. **Accounts have owners.** Until now any `X-Client-Id` could transfer from
   any account. That is not a bug a model can be trusted around.
2. **The assistant has its own database role that can only read, and only
   its client's rows.** Enforced by Postgres, not by the Python code being
   careful.
3. **The client the assistant acts for comes from the request, never from the
   model.** Tools take it as their first argument; a model fills in the rest.

No model yet. `agent/` is the fence; 7b puts the model behind it.

```
migrations/008_account_ownership_and_agent_access.sql   ownership, role ledger_agent, views, row-level security
src/http/transfers.ts, topups.ts                        the ownership check (404)
tests/ownership.test.ts, tests/agent-access.test.ts     the fence, tested from the TypeScript side
agent/                                                  Python 3.12 + uv: FastAPI probes, psycopg 3, three tools, pytest
```

---

## 1. Ownership, and why "not yours" is a 404

`accounts.owner_client_id` names the one client that may spend from a user
account and top it up. System accounts (`bank_settlement`, fees) have no
owner: nobody spends from them through the API. The database enforces the
shape: `CHECK ((kind = 'system') = (owner_client_id IS NULL))`, an owner that
cannot change once set, and the API role may INSERT an owner but never UPDATE
one.

The check in `POST /transfers` runs inside the idempotent callback, before any
lock is taken:

```ts
SELECT owner_client_id FROM accounts WHERE id = $1     -- fromAccountId
-- not the caller's?  ->  404 { code: 'account_not_found', message: 'account <id> does not exist' }
```

**403 or 404?** 403 is the honest answer ("exists, not yours"); 404 is the safe
one. The difference matters for someone probing: send `fromAccountId` after
`fromAccountId`, and 403 vs 404 tells them which UUIDs are real accounts, which
is the first step of guessing a target. With 404, "not yours" and "not there"
are **byte-for-byte the same response** (test 1 checks exactly that), so the
probe learns nothing. The real reason (`not_owner` vs `missing`) goes to the
server log with the client id, for support. The response is a business answer,
so it is stored under the idempotency key and replayed like a 422 would be.

`toAccountId` stays open: paying someone is the point, and knowing an id to
pay is the same leak as an account number on an invoice. The top-up rule is
the same: only the owner may top an account up; a system account, which
nobody owns, is 404 for everyone (it used to be 422 `not_a_user_account`,
which was a small existence leak of its own).

**Rows from before this migration** keep a NULL owner (the CHECK is added
`NOT VALID`, so old rows are exempt and new rows are not). A NULL owner
matches no caller: those accounts cannot be used through the API until an
owner is assigned, which is the one change the trigger allows (NULL to a value).

---

## 2. Row-level security, with an analogy

A hotel has one big filing cabinet with every guest's folder. The old rule was
"staff may open the cabinet". The new rule is a librarian who sits in front of
it: you say *who you are acting for*, and whatever drawer you reach for, the
librarian only hands you the folders with that guest's name on them. You can
ask for "all folders" and get four. You can ask the cleverest question you like;
the answer is still filtered before you see it. And if you forgot to say who you
are acting for, you get nothing, not everything.

That librarian is **row-level security** (RLS). A table with RLS enabled shows
a role nothing unless a **policy** says which rows; the policy is a WHERE clause
Postgres appends to every query that role runs, including queries nobody
anticipated. The agent's policies:

```sql
accounts      USING (owner_client_id = agent_client_id())
transactions  USING (id             IN (SELECT agent_transaction_ids()))
entries       USING (transaction_id IN (SELECT agent_transaction_ids()))
topups        USING (transaction_id IN (SELECT agent_transaction_ids()))
```

`agent_client_id()` reads the setting `app.client_id`, which the agent sets
**per request, inside the transaction, through a bind parameter**:

```sql
BEGIN READ ONLY;
SELECT set_config('app.client_id', $1, true);   -- $1 = the X-Client-Id; true = LOCAL to this transaction
SELECT ... FROM agent_accounts ...;
COMMIT;
```

Three details carry the weight:

- **A bind parameter, never string-built `SET`.** `SET app.client_id = '...'`
  cannot take a parameter, so a client id would have to be pasted into SQL,
  and then a client id of `'; RESET ROLE; --` is a question of quoting. With
  `set_config(..., $1, ...)` the id is data, full stop. Test 6 (TypeScript) and
  `test_a_hostile_client_id_is_plain_data` (Python) send ids with quotes,
  semicolons, newlines and `RESET ROLE` in them, and show that `current_setting`
  returns exactly that string, `current_user` is still `ledger_agent`, nothing
  of the real client leaks, and an account whose owner really is that string
  is simply visible to it.
- **LOCAL.** The setting dies with the transaction. The agent uses a connection
  pool; the next request on the same connection starts with no client id and
  sees nothing (test 5).
- **Unset means nothing, not everything.** `current_setting(..., true)` returns
  NULL when unset; NULL equals no owner. Forgetting the step is a blank answer,
  never a leak.

**What you can see:** your own accounts, and **every leg of every transaction
you took part in**. The counterparty's leg shows its account id and the
amount, as a bank statement shows the other party's account number; the
counterparty's *account row* (name, balance, owner) does not exist for you.
`agent_entries.own_account` tells the two apart. "Took part in" is computed by
`agent_transaction_ids()`, a `SECURITY DEFINER` function owned by `ledger_owner`:
it runs with the owner's eyes, so the policy on `entries` can ask a question
about `entries` without Postgres' "infinite recursion in policy" error, and it
returns only ids, only for the client in `app.client_id`.

**The service roles got policies too.** Enabling RLS on a table hides every
row from every non-owner role until a policy says otherwise, so `ledger_app`,
`ledger_worker` and `ledger_reconciler` have an explicit "all rows" policy.
What they may *do* is still the GRANTs (column lists, no DELETE). Test 7 checks
the API role sees everything; the rest of the suite would fail loudly if the
reconciler suddenly saw an empty ledger.

### What RLS does NOT protect against

RLS answers one question: *given the client id this transaction carries, which
rows?* It cannot know whether that client id is **right**. If the agent service
sets `app.client_id` to `bob` for a request that came from `alice`, Postgres
hands over Bob's rows, correctly, to the wrong person. That boundary is
**authentication**: making sure the request really is from the client it
claims. In this step that is still the `X-Client-Id` header, a stand-in with
no proof behind it; the agent trusts it the way the API has since step 3. The
fence in Postgres makes the blast radius of a bug in the Python code "that one
client's data", never "everyone's"; it does not make the header true. A later
step replaces the header with real authentication, and nothing in Postgres has
to change for that.

---

## 3. Views as a contract

The agent reads `agent_accounts`, `agent_transactions`, `agent_entries` and
`agent_topups`: exactly the columns an assistant needs, nothing from
`idempotency_keys` (stored responses), `webhook_events` (raw provider
payloads), `outbox` or `reconciliation_runs`, and no provider payment ids.
Two consequences:

- **A contract for the Python code.** Tables can gain columns, be split or
  renamed; as long as the views keep their shape, the agent does not change.
- **A contract for reviewers.** "What can the assistant see?" is answered by
  reading four `CREATE VIEW` statements, not by auditing every query.

The views are created `WITH (security_invoker = true)`: a view normally runs
with the privileges of its *owner*, and the owner is `ledger_owner`, who is not
subject to RLS. `security_invoker` makes the view run as the caller, so the
policies apply inside it. The caller then also needs SELECT on the base
tables, and those grants are **column lists** (test 3: `SELECT *` on `accounts`
is refused; `owner_client_id` and `provider_payment_id` are never readable).
So a hand-written query on the base tables gets the same rows and the same
columns as the views: the views are the contract, the grants and policies are
the fence.

---

## 4. The client id never comes from the model

In 7b a model will choose which tool to call and with what arguments. If
`client_id` were a tool argument, a model that was asked nicely ("show me what
account X of client bob holds") or tricked by text in a transaction note
would fill it in. So:

```python
class LedgerTools:
    def get_balance(self, ctx: ClientContext, account_id: UUID) -> Balance: ...
    def list_transactions(self, ctx: ClientContext, account_id: UUID, from_, to, limit) -> list[TransactionSummary]: ...
    def explain_transaction(self, ctx: ClientContext, transaction_id: UUID) -> TransactionDetail: ...
```

`ctx` is built in one place, `ClientContext.from_header(request.headers["X-Client-Id"])`,
and is the first argument of every tool. A model will only ever see the
arguments after it. `test_the_client_id_is_never_a_tool_argument` inspects the
signatures so nobody adds one by accident. Underneath, every tool opens
`client_scope(pool, ctx)`: one READ ONLY transaction with the client id bound,
and the pool's connections are configured `read_only` as a second belt next to
the grants.

**Money is `int` all the way.** Postgres `BIGINT` → psycopg → Python `int`
(arbitrary precision) → pydantic `int` fields. `test_get_balance_returns_the_clients_account_as_integer_paise`
stores 9,007,199,254,740,993 paise (2⁵³ + 1, which a float would round) and
reads it back exactly.

**"Not found" is one answer.** The tools cannot tell "does not exist" from
"not yours": the views simply do not contain other clients' rows. That is the
404 decision of section 1 again, one layer down, for free.

---

## 5. Cost: what the policies do to query plans

Policies are WHERE clauses, so they need indexes like any other. Measured on
the dev database with a load-test-sized ledger (50 clients × 4 accounts,
100,000 transfers, 200,000 entries, 200 top-ups; one client with ~4,000 legs),
as `ledger_agent` with `app.client_id` set:

| query | before | covering indexes | + `transactions(created_at)` (two runs) |
|---|---|---|---|
| `agent_transaction_ids()` (the policies' subquery) | 29 ms, 2,786 buffers | **2.3 ms**, index-only | 2.0–2.3 ms |
| `agent_accounts` | 0.24 ms | 0.14 ms | 0.14–0.24 ms |
| `list_transactions` (newest 50 on one account, 90 days, with counterparty) | 230 ms | 56 ms | **32–64 ms** |
| `explain_transaction` (one transaction's legs) | 81 ms | 10 ms | **10–30 ms** |

(The second run was on a freshly regenerated random ledger with the suites
running on the same machine; the plans are the same, the laptop is not.)

Two things the first plan showed. The function was being evaluated **once per
policy reference** (three times in `list_transactions`), and each evaluation
fetched every one of the client's entries from the heap through
`entries_account_id_idx`. Replacing that index with `entries (account_id)
INCLUDE (transaction_id)` (and the same for `topups`) turns each evaluation
into an index-only scan. The window filter then still sequentially scanned
`transactions`; `transactions (created_at)` fixes that. All three indexes are
in migration 008. The cost that remains is proportional to the client's own
activity, not to the ledger.

The final plan for `list_transactions`, as `ledger_agent` (`EXPLAIN (ANALYZE, BUFFERS)`):

```
: newest 50 movements on one account, with counterparty
 Limit (actual time=47.517..63.894 rows=50 loops=1)
   Buffers: shared hit=1654
   InitPlan 3
     ->  Limit (actual time=0.064..0.065 rows=1 loops=1)
           Buffers: shared hit=8
           ->  Sort (actual time=0.063..0.064 rows=1 loops=1)
                 Sort Key: accounts.name
                 Sort Method: top-N heapsort  Memory: 25kB
                 Buffers: shared hit=8
                 ->  Seq Scan on accounts (actual time=0.024..0.046 rows=4 loops=1)
                       Filter: ((kind = 'user'::text) AND (owner_client_id = NULLIF(current_setting('app.client_id'::text, true), ''::text)))
                       Rows Removed by Filter: 197
                       Buffers: shared hit=5
   ->  Result (actual time=47.516..63.865 rows=50 loops=1)
         Buffers: shared hit=1654
         ->  Sort (actual time=44.008..44.031 rows=50 loops=1)
               Sort Key: transactions.created_at DESC
               Sort Method: top-N heapsort  Memory: 36kB
               Buffers: shared hit=1357
               ->  Nested Loop (actual time=30.091..43.862 rows=267 loops=1)
                     Buffers: shared hit=1354
                     ->  Index Scan using accounts_id_currency_key on accounts a (actual time=0.103..0.108 rows=1 loops=1)
                           Index Cond: (id = (InitPlan 3).col1)
                           Filter: (owner_client_id = NULLIF(current_setting('app.client_id'::text, true), ''::text))
                           Buffers: shared hit=11
                     ->  Hash Join (actual time=29.984..43.711 rows=267 loops=1)
                           Hash Cond: (transactions.id = e.transaction_id)
                           Buffers: shared hit=1343
                           ->  Bitmap Heap Scan on transactions (actual time=22.994..36.362 rows=1037 loops=1)
                                 Recheck Cond: (created_at >= (now() - '90 days'::interval))
                                 Filter: (ANY (id = (hashed SubPlan 4).col1))
                                 Rows Removed by Filter: 23686
                                 Heap Blocks: exact=933
                                 Buffers: shared hit=1246
                                 ->  Bitmap Index Scan on transactions_created_at_idx (actual time=4.581..4.581 rows=24723 loops=1)
                                       Index Cond: (created_at >= (now() - '90 days'::interval))
                                       Buffers: shared hit=142
                                 SubPlan 4
                                   ->  ProjectSet (actual time=13.822..17.115 rows=4038 loops=1)
                                         Buffers: shared hit=171
                                         ->  Result (actual time=0.000..0.001 rows=1 loops=1)
                           ->  Hash (actual time=6.972..6.974 rows=994 loops=1)
                                 Buckets: 1024  Batches: 1  Memory Usage: 86kB
                                 Buffers: shared hit=97
                                 ->  Bitmap Heap Scan on entries e (actual time=4.975..6.675 rows=994 loops=1)
                                       Recheck Cond: (account_id = (InitPlan 3).col1)
                                       Filter: (ANY (transaction_id = (hashed SubPlan 5).col1))
                                       Heap Blocks: exact=16
                                       Buffers: shared hit=97
                                       ->  Bitmap Index Scan on entries_account_id_idx (actual time=0.066..0.067 rows=994 loops=1)
                                             Index Cond: (account_id = (InitPlan 3).col1)
                                             Buffers: shared hit=8
                                       SubPlan 5
                                         ->  ProjectSet (actual time=1.759..3.991 rows=4038 loops=1)
                                               Buffers: shared hit=73
                                               ->  Result (actual time=0.000..0.001 rows=1 loops=1)
         SubPlan 2
           ->  Limit (actual time=0.394..0.394 rows=1 loops=50)
                 Buffers: shared hit=297
                 ->  Index Scan using entries_transaction_id_idx on entries e_1 (actual time=0.393..0.393 rows=1 loops=50)
                       Index Cond: (transaction_id = transactions.id)
                       Filter: ((ANY (transaction_id = (hashed SubPlan 1).col1)) AND (account_id <> e.account_id))
                       Rows Removed by Filter: 0
                       Buffers: shared hit=297
                       SubPlan 1
                         ->  ProjectSet (actual time=1.030..2.786 rows=4038 loops=1)
                               Buffers: shared hit=73
                               ->  Result (actual time=0.000..0.001 rows=1 loops=1)
 Planning:
   Buffers: shared hit=282 read=1
 Planning Time: 5.143 ms
 Execution Time: 64.139 ms
(72 rows)
```

---

## 6. The Python service

`agent/` is a separate program with its own toolchain: Python 3.12, `uv`
(lock file committed, `uv sync --frozen` in CI and in the image), FastAPI for
`/healthz` and `/readyz` (ready = the database answers as `ledger_agent` **and**
migration 008 is applied), psycopg 3 with a small pool, pydantic models for
every tool's output, ruff + mypy (strict) + pytest. The tests run against the
real `ledger_test` database: they seed as `ledger_owner` and read as
`ledger_agent`, with a fresh client id per test, so they never need to truncate
anything and can run next to the TypeScript suite.

The image (`agent/Dockerfile`) is `python:3.12-slim` with the locked
dependencies in a virtualenv, running as uid 1000 like the Node images, so the
same Kubernetes securityContext will fit in 7b. `docker-compose.full.yml` runs
it as `agent` on port 8000.

---

## 7. Questions

1. A client sends `fromAccountId` = a system account. Walk through the exact
   response and the exact log line, and say what a 403 would have told them
   instead.
2. Why is the ownership check placed *inside* the idempotent callback rather
   than before it? What would change for a retry if it were outside?
3. `SET app.client_id = 'x'` and `SELECT set_config('app.client_id', $1, true)`
   both set the same setting. Which one would let `'; RESET ROLE; --` do
   anything, and why does the other not care what the string contains?
4. The agent's pool hands the same connection to request 1 (client A) and then
   request 2 (client B). Which single word in the `set_config` call prevents
   request 2 from seeing A's rows if the Python code forgot to set B?
5. `agent_transaction_ids()` is `SECURITY DEFINER`. What would happen if it were
   not, and what does it risk being `SECURITY DEFINER`? What limits that risk here?
6. Client A sees the counterparty's account id and amount in a transfer, but
   not the counterparty's name. Point at the policy and the view that make
   each of those two facts true.
7. Enabling RLS on `accounts` with only the agent's policy, and no
   `service_roles_all_rows`, would not error. What would the reconciliation
   job report that night, and which test would have caught it first?
8. The views have `security_invoker = true`. If a future migration drops that
   option by mistake, which test fails, and what would the agent see?
