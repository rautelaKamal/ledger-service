# Step 2 notes

Step 2 closes the lifecycle gaps from step 1 (migration 002) and sets up the tests for
`transfer()`. The transfer itself is not implemented yet: `src/ledger/transfer.ts` is a stub,
and `tests/transfer.test.ts` stays red until it is written.

---

## Debit / credit convention

Step 1 used this convention without writing it down. From now on it is explicit:

- a **credit increases** an account's balance
- a **debit decreases** it
- `balance_paise = sum(credits) − sum(debits)`, over entries of posted transactions

A transfer of X from A to B is **debit A by X, credit B by X**. Funding a user from the bank
is **debit `bank_settlement`, credit the user**, so `bank_settlement` (a system account)
goes negative. That's expected: it represents money owed by the bank.

---

## The transaction lifecycle

All of this happens inside **one** database transaction:

```
INSERT INTO transactions (kind, note)        -> status 'pending' (the default)
INSERT INTO entries (...)                    -> allowed only while 'pending'
UPDATE transactions SET status = 'posted'    -> needs >= 2 entries; the DB stamps posted_at
COMMIT                                       -> deferred checks: debits = credits per currency,
                                                and every transaction with entries is 'posted'
```

A transaction that never received entries may instead become `failed`.
**Result: a transaction has entries if and only if it is posted.**

---

## The six new rules

| # | Rule | Enforced by | Proven by (tests/db-guarantees.test.ts) |
|---|------|-------------|------------------------------------------|
| 1 | A new transaction always starts as `pending` | **Grant:** `REVOKE INSERT (status, posted_at)`; the app keeps `INSERT (kind, note)` | 9 |
| 2 | Entries only for a `pending` transaction | **Trigger** `entries_only_for_pending_transaction` (BEFORE INSERT, `SELECT … FOR SHARE`) | 10, and 11 (works under the app's grants) |
| 3 | Posting needs at least 2 entries | **Trigger** `transactions_status_change_rules` | 12 |
| 4 | `failed` only with 0 entries | **Trigger** `transactions_status_change_rules` | 13 |
| 5 | `posted_at` is set when, and only when, the status becomes `posted` | **Trigger** stamps `now()` and rejects direct writes; **grant:** `REVOKE UPDATE (posted_at)`; the **CHECK** from 001 stays | 14 |
| 6 | At COMMIT, every transaction with entries is `posted` | **Deferred constraint trigger** `entries_transaction_must_be_posted` | 15 |

Each test was proven to fail when its rule is removed: re-grant the privilege, drop the
trigger, or remove that block from the trigger function. Each test then passed again
after the schema was rebuilt from the migrations.

`ledger_app` grants on `transactions` after 002: `SELECT`, `INSERT (kind, note)`,
`UPDATE (status)`.

### `posted_at` is stamped by the database with `now()`

`now()` is the start time of the current **database transaction**, so it is the same value
for every statement in it.

- **Transfer:** the row is inserted and posted in the same database transaction, so
  `posted_at = created_at`, exactly.
- **Future webhook top-ups:** the transaction will be created `pending` when the payment
  starts and posted later, in a **different** database transaction (when the bank's webhook
  arrives). Then `posted_at` will be later than `created_at`, and the difference is how
  long the payment took to confirm.

### Rule 2 depends on `ledger_app` keeping `UPDATE (status)`

The rule 2 trigger runs `SELECT … FOR SHARE` on the transaction row. The lock stops another
session from posting or failing that transaction between the check and our COMMIT.
Postgres only lets a role take a `FOR SHARE` lock if it holds **UPDATE on at least one
column** of the table. The trigger runs as the caller (`ledger_app`), so if `ledger_app`
ever lost `UPDATE (status)`, every entry insert would fail with a permission error. Test 11
proves that the app can insert an entry into a pending transaction under its real grants.

### Deliberately left as is: the owner can insert a `posted` transaction directly

Rule 1 is enforced by a **grant**, so it binds `ledger_app` only. `ledger_owner` still has
full INSERT and could write `INSERT INTO transactions (kind, status, posted_at) VALUES
('topup', 'posted', now())`. Such a row has no entries, and rule 6 can't catch it, because
rule 6 fires on entry inserts. As in step 1: grants are the security boundary; triggers are
guardrails against bugs. The owner is trusted, and the app never connects as the owner.

---

## Reconciliation

`src/ledger/reconciliation.ts` exports `UNRECONCILED_ACCOUNTS_SQL`. It lists every account
whose cached `balance_paise` differs from credits − debits of its posted entries. An empty
result means the ledger reconciles. The transfer tests run it after **every** test
(`expectLedgerReconciles`), and the future reconciliation job will run the same query.

---

## Transfer tests (`tests/transfer.test.ts`)

**Setup**
- `beforeAll` TRUNCATEs the ledger as the owner. Step 1 tests deliberately leave accounts
  whose cached balance doesn't match their entries (step 1 test 4 sets a balance
  directly), so "every account reconciles" must start from a clean ledger. This is safe
  because test files run one after another.
- Accounts are funded with `fundAccount()`, which writes a real posted `topup` from
  `bank_settlement`, as `ledger_owner`. It never edits a balance without the matching
  entries.

**Pool size and timeouts**
- **App pool `max: 20`.** The concurrency tests fire 100 transfers at once. They queue on
  20 connections, so about 20 database transactions are in flight at any moment, all
  fighting over the same one or two account rows. That's enough overlap to expose lost
  updates and lock-order deadlocks every run. Postgres here allows `max_connections = 100`,
  and 20 (app) + 2 (owner) + 1 (setup) leaves plenty of headroom.
- **`connectionTimeoutMillis: 10_000`.** A test waiting for a free connection fails after
  10 s instead of hanging.
- **Concurrency tests: 30 s timeout.** A correct transfer serializes on row locks at a few
  ms each, so 100 transfers take well under 2 s. An implementation that deadlocks spends
  about `deadlock_timeout` (1 s here) before Postgres detects each deadlock. 30 s leaves room
  for that, so the test fails on a *wrong result* rather than a timeout, and still fails
  quickly in CI.

**Expected state until `transfer()` is written:** the 15 DB guarantee tests pass, and the 5
transfer tests fail with `not implemented: Kamal writes this`. CI on this branch is red
for that reason.

---

## Changes to step 1 tests

Migration 002 made some step 1 helpers invalid. They now follow the lifecycle:

- `createTransaction` inserts only `kind` (status defaults to `pending`).
- `commitBalancedTransaction` posts the transaction before COMMIT and returns its id.
- Test 3 posts both its transactions, so it still tests exactly the balance rule.
- Test 6 posts a transaction with balanced entries before trying to change it.
- Test 3 always rolls back before releasing its connection, so a failed assertion can't
  hand an aborted transaction to the next test.
