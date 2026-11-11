# Step 2, explained: `transfer()`

This is the walkthrough of `src/ledger/transfer.ts`. The database rules it relies on
(migration 002) are explained in [STEP-02-NOTES.md](STEP-02-NOTES.md). Read the code
side by side with this file; the step numbers match the comments.

---

## 1. The bank counter, or the khata with two clerks

Think of the shopkeeper's khata again, but now there are **two clerks** and one book.

Ramesh has ₹50 on his page. Two customers arrive at the same moment, each holding a
chit from Ramesh for ₹50. Clerk 1 looks at the page: "₹50, fine." Clerk 2 looks at the
same page a second later: "₹50, fine." Both write "−50". Ramesh's page now shows −₹50, and
the shop has handed out ₹100 that it will never get back. Nobody did anything wrong on
purpose; they simply both *looked* before either had *written*.

The fix every real counter uses is simple: **a clerk picks up the page before reading it,
and nobody else may touch that page until the clerk puts it down.** Clerk 2 now waits.
When clerk 1 puts the page down it says ₹0, and clerk 2 says "sorry, no funds."

That "picking up the page" is exactly what `SELECT … FOR UPDATE` does to a row. The row
is yours until you COMMIT or ROLLBACK; anyone else who wants to pick it up waits in line.

There is one more rule at the counter. A transfer touches **two** pages, the sender's and
the receiver's. Suppose clerk 1 is doing Ramesh → Sita and picks up Ramesh's page first.
Clerk 2 is doing Sita → Ramesh and picks up Sita's page first. Now clerk 1 waits for
Sita's page, clerk 2 waits for Ramesh's page, and both wait forever. That's a
**deadlock**. The counter rule that prevents it: **always pick up pages in the same
order, no matter which direction the money goes**, say alphabetical. Both clerks reach
for Ramesh's page first; one gets it, the other waits, and when the first is done the
second proceeds. We use the account id instead of the alphabet, but it's the same idea.

---

## 2. `transfer()` line by line

### Step 0: validate, before touching the database

```ts
if (input.amountPaise <= 0n) throw new InvalidAmountError(...)
if (input.fromAccountId === input.toAccountId) throw new SameAccountError(...)
```

Two checks that need no database at all. They run before we even borrow a connection, so
an invalid request can't write anything, not even a transaction row. Test 2 counts the rows
before and after to prove it.

### Step 1: one client, one transaction

```ts
const client = await pool.connect();
await client.query('BEGIN');
```

A pool hands out connections. `pool.query(...)` would run each statement on *whichever*
connection is free, which might be a different one every time. A row lock belongs to the
connection that took it, so if the inserts ran on a different connection than the lock,
they wouldn't be protected by it. We borrow one client and run every statement on it.

`BEGIN` opens the database transaction. Nothing after it is visible to anyone else until
`COMMIT`, and if anything fails, `ROLLBACK` erases all of it.

### Step 2: lock both accounts, in ascending id order

```sql
SELECT id, currency, balance_paise
  FROM accounts
 WHERE id = ANY($1::uuid[])
 ORDER BY id
   FOR UPDATE
```

The heart of the function. Three things happen in this one statement:

1. **It reads** the two rows we need: currency and balance.
2. **`FOR UPDATE` locks them.** If another transfer already holds a lock on either row,
   this statement *waits* until that transfer commits or rolls back, and then returns the
   row as that transfer left it. From here until our COMMIT, nobody else can lock or change
   these rows.
3. **`ORDER BY id` fixes the lock order.** Postgres locks rows in the order it returns
   them. Every transfer, whether A→B or B→A, locks the lower id first. Two transfers on the
   same pair queue up instead of grabbing one row each and waiting for the other.

**Why READ COMMITTED is enough.** Postgres' default isolation level lets each statement see
whatever was committed when that statement started. Normally that's dangerous for
read-then-write logic: a plain `SELECT balance` could return a number that another
transaction changes a millisecond later. But a `FOR UPDATE` read is different. It waits
for in-flight changes to finish and then returns the latest committed value, and it keeps
the row locked so nothing can change it under us. Since the balance check in step 4 uses
only this locked read, READ COMMITTED is safe here, with no need for SERIALIZABLE and its
retry loops.

### Step 3: both accounts exist, one currency

```ts
const from = rows.find((r) => r.id === input.fromAccountId);
const to   = rows.find((r) => r.id === input.toAccountId);
```

We asked for two ids. If a row is missing, that account doesn't exist →
`AccountNotFoundError`, naming the id. If the currencies differ →
`CurrencyMismatchError`. The database would also reject a mismatched currency (the
composite foreign key), but checking here gives a clear error before we write anything.

### Step 4: can the sender afford it?

```ts
if (from.balance_paise < input.amountPaise) throw new InsufficientFundsError(...)
```

`from.balance_paise` is the balance **we locked**. No other transfer can lower it before we
COMMIT, so if the check passes now, it's still true when we write. This single line, backed
by the lock from step 2, is what makes test 4 pass: 100 transfers each see the real,
current balance, one after another.

### Step 5: create the transaction, `pending`

```sql
INSERT INTO transactions (kind, note) VALUES ('transfer', $1) RETURNING id
```

The app can't set `status` on insert (rule 1), so it starts as `pending`. `RETURNING id`
gives us the new UUID without a second query.

### Step 6: write the two entries

```sql
INSERT INTO entries (...) VALUES
  ($1, from, currency, 'debit',  amount),
  ($1, to,   currency, 'credit', amount)
```

The two khata lines: debit the sender, credit the receiver, same amount. The currency is
the one we read from the accounts, so the composite foreign key is satisfied. Both rows go
in one statement; there's no state in which only one exists.

### Step 7: update the cached balances

```sql
UPDATE accounts SET balance_paise = balance_paise - $2 WHERE id = $1   -- sender
UPDATE accounts SET balance_paise = balance_paise + $2 WHERE id = $1   -- receiver
```

Relative updates, "subtract X" rather than "set to 4900". We hold the locks, so an absolute
write would also be correct, but a relative one says what it means, and the `CHECK` that
user balances stay ≥ 0 remains a last line of defence if the code above ever had a bug.

### Step 8: post it

```sql
UPDATE transactions SET status = 'posted' WHERE id = $1
```

The trigger from migration 002 checks that there are at least two entries and stamps
`posted_at = now()`. We never write `posted_at` ourselves; the app isn't allowed to.

### Step 9: COMMIT

Two deferred triggers run right here, before COMMIT is accepted: *debits = credits per
currency*, and *every transaction with entries is posted*. If either fails, the whole
transfer is rolled back by Postgres. If they pass, everything becomes visible at once and
the row locks are released, so the next transfer in line can proceed.

### On error: ROLLBACK, and always release

```ts
} catch (err) {
  try { await client.query('ROLLBACK'); } catch { connectionBroken = true; }
  throw err;
} finally {
  client.release(connectionBroken ? true : undefined);
}
```

Any throw between BEGIN and COMMIT, ours or Postgres', lands here. `ROLLBACK` undoes
everything; the original error is rethrown so the caller sees `InsufficientFundsError`
and not something generic. `finally` releases the client **every time**. That matters: if
a client went back to the pool still inside an aborted transaction, the next caller's
first query would fail with "current transaction is aborted". If ROLLBACK itself fails,
the connection is dead, and `release(true)` tells the pool to destroy it rather than
hand it out again.

---

## 3. What tests 4 and 5 catch

`npm run demo:race` runs both scenarios against naive implementations and against the
real one, so you can watch the numbers below happen.

### Test 4: 100 concurrent ₹1 transfers from an account holding ₹50

**Without the lock** (read balance, check, write back): every transfer that starts before
the first one commits reads "₹50". They all pass the check, and each writes back "₹49".
A typical demo run:

```
succeeded: 100   insufficient funds: 0
A = ₹49.00   B = ₹1.00   (expected A = ₹0.00, B = ₹50.00)
books balance? NO:
  account A: cached 4900, entries say -5000
  account B: cached 100,  entries say 10000
```

All 100 "succeeded", 100 pairs of entries were written, but the cached balances record
only one of them. The entries say A paid out ₹100 it never had. This is the lost update:
the writes overwrote each other.

**With the lock:** `succeeded: 50, insufficient funds: 50, A = ₹0.00, B = ₹50.00`, and the
books balance.

### Test 5: 50 A→B and 50 B→A at the same time

**Locking sender first, then receiver:** A→B transfers grab A and wait for B; B→A transfers
grab B and wait for A. Postgres notices after `deadlock_timeout` (1 s) and kills one side
with error `40P01`. A typical demo run (exact counts vary with timing):

```
succeeded: 2   deadlocks (40P01): 39
gave up waiting for a connection: 59
took 21193 ms
```

Only a handful of 100 valid transfers went through. Dozens died as deadlock victims, and
because each deadlock held two connections for about a second, most of the rest couldn't
even get a connection within 10 seconds. One wrong lock order turned 100 valid ₹1 transfers into a
21-second outage. (Total money was still correct, because each failed transfer rolled
back cleanly; deadlocks lose availability, not money.)

**With `ORDER BY id`:** `succeeded: 100, deadlocks: 0, took ~250 ms`, balances back to
₹50 / ₹50.

---

## 4. Eight questions to answer before calling Phase 1 done

1. Why must every statement in `transfer()` run on the same client, and what could go wrong if step 5 ran via `pool.query` instead?
2. Under READ COMMITTED, a plain `SELECT balance_paise` can return a stale number. Why is `SELECT … FOR UPDATE` not subject to the same problem?
3. Explain the deadlock in test 5 with two specific transfers, naming which row each one holds and which it waits for. Why does `ORDER BY id` break the cycle?
4. In the no-lock demo, 100 transfers succeeded but B ended up with only ₹1. Where did the other 99 credits go?
5. Steps 5–8 happen in a fixed order: transaction → entries → balances → post. Which database rules would reject each possible reordering?
6. If the balance check in step 4 were removed, which database constraint would catch an overdraft on a *user* account, and why isn't that constraint enough on its own for a *system* account?
7. Why does the `finally` block release the client even on success, and what happens to the next caller if a client is returned mid-transaction?
8. The demo's deadlock scenario lost availability but not money. What property of transactions guarantees that, and what would you have to break to actually lose money?
