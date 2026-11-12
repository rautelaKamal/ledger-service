# Step 4, explained: money coming in, confirmed by signed webhooks

Step 4 adds the other direction of money: a **top-up** from a payment provider. Read this
next to `src/http/topups.ts`, `src/webhooks/signature.ts`, `src/webhooks/process.ts` and
`mock-provider/`.

---

## 1. The problem

When a user taps "top up ₹250", nothing has happened yet. The money is still in their
bank. The payment provider will try to collect it, and *later* it will tell us whether it
worked. If we credited the ledger at the tap, we would be lending the user ₹250 of our own
money on the hope that the provider succeeds.

So: **credit only when the provider confirms**. The confirmation arrives as a webhook, an
HTTP request the provider makes *to us*. And webhooks are a hostile input:

| What can happen | Why it's normal | What must be true |
|---|---|---|
| **forged** | our URL is public; anyone can POST to it | only the provider's messages count |
| **replayed** | a captured genuine webhook, sent again later | a message is good for minutes, not forever |
| **duplicated** | the provider resends when it isn't sure we got it | credit once, however many deliveries |
| **delayed** | queues, outages, retries | a late message must not re-decide a settled top-up |
| **out of order** | `failed` and `succeeded` take different paths | the ledger's first answer stands |

Every one of those must be *harmless*: no money moves that shouldn't, and nothing crashes
into a retry loop.

---

## 2. pending → posted, in two transactions

```
POST /topups                               POST /webhooks/provider
──────────────                             ────────────────────────
transactions: kind topup, status pending   verify signature over raw bytes
  (0 entries, no balance change)           find the top-up by paymentId, lock its row
provider.createPayment(...) -> paymentId   in ONE database transaction:
topups: transaction <-> paymentId            entries: debit bank_settlement, credit user
202 { topupId, status: "pending" }           balances updated, status -> posted
                                             webhook_events row with the result
                                           COMMIT -> 200 { received, result }
```

This is why migration 002's rules shaped the transaction lifecycle the way they did: a
top-up is a transaction that genuinely *lives* in `pending` for a while, with no entries,
and `posted_at` ends up later than `created_at` (test 2 checks exactly that). Rule 6 still
holds at every COMMIT: entries exist if and only if the transaction is posted.

**Where the money comes from.** A confirmed top-up debits the system account
`bank_settlement` (INR, seeded by migration 004) and credits the user. `bank_settlement`
goes more negative with every top-up: it records how much of the money we hold came from
the bank. That is expected for a system account.

---

## 3. How HMAC signing works

### The analogy: the wax seal

A letter from the bank arrives. How do you know the bank sent it, and that nobody changed
it on the way? In the old days: a **wax seal** pressed with a signet ring that only the
bank owns. Anyone can read the letter, but nobody else can make that seal, and if the
letter is opened and altered, the seal breaks.

HMAC is the seal. The **secret** (`WEBHOOK_SECRET`) is the signet ring: both the provider
and we have a copy, nobody else. The provider computes

```
v1 = HMAC-SHA256(secret, "<t>.<raw body>")
Provider-Signature: t=<unix seconds>,v1=<hex>
```

and we compute the same thing from what we received. Same result → the message was made by
someone holding the secret and arrived byte-for-byte intact. Different → reject.

Three details make the seal unbreakable in practice:

**Why the timestamp is inside the signed text.** If only the body were signed, a captured
webhook could be replayed next week and would still verify. With `t` inside the HMAC, a
replay is either too old (we reject `now − t > 5 min`) or has a changed `t`, which changes
the expected signature, which only the secret holder could produce. We also reject `t`
more than 30 s in the future, because clocks on two machines are never perfectly in sync
but a message from an hour ahead is not a clock problem.

**Why raw bytes.** The signature is over the exact bytes the provider sent. If we parsed
the JSON and re-serialised it, a reordered key or a dropped space would change the bytes
and break a perfectly genuine signature. So the webhook route uses `express.raw()` and is
mounted *before* `express.json()`, and we parse JSON only after the signature passes.

**Why a constant-time compare.** A normal `===` on two strings stops at the first
different character. Measured over thousands of requests, that timing difference tells an
attacker how many leading characters of their guess were right, and they can brute-force
the signature one character at a time. `crypto.timingSafeEqual` takes the same time
whether the first byte or the last byte differs, so timing reveals nothing.

---

## 4. Why duplicates are normal, and exactly-once on our side

A provider cannot know whether we processed a webhook; it only knows whether it got a
2xx back. If the connection drops after we committed but before our `200` reached them,
the only safe thing they can do is **send it again**. That's *at-least-once delivery*,
and the mock provider does it too (`deliverWithRetry`: doubling backoff while we answer
non-2xx). So duplicates are not a bug on their side; they are the contract.

Exactly-once is therefore **our** job, and it's the same shape as step 3's idempotency
key: the provider's event id is the primary key of `webhook_events`, and the ledger
change and the event row commit together.

```
BEGIN
SELECT … FROM webhook_events WHERE provider_event_id = $1     seen? -> ROLLBACK, 200 duplicate
SELECT … FROM topups JOIN transactions … FOR UPDATE OF transactions
                                                              serialises every event for one payment
decide: posted / failed / ignored_already_final / anomaly / unmatched / unknown type
apply (entries, balances, status) if posted or failed
INSERT INTO webhook_events (…, result) ON CONFLICT DO NOTHING RETURNING 1
                                                              0 rows? a concurrent duplicate won -> ROLLBACK, 200 duplicate
COMMIT
```

Ten identical deliveries at the same instant (test 4): all ten pass the first check, all
ten queue on the transaction row lock, the first posts and inserts its event, the other
nine then see `status = posted`, compute `ignored_already_final`, hit the conflict on the
event id, and roll back. One credit, one event row, ten `200`s.

**Why `200` for things we didn't apply.** `unmatched` (unknown paymentId), `ignored_*`
(late/out of order) and `anomaly_amount_mismatch` all answer `200`. A non-2xx means
"deliver again", and delivering again can never change the outcome: the paymentId will
still be unknown, the top-up will still be final, the amount will still be wrong. Retrying
would only burn the provider's retry budget and, at some providers, trigger alerts. We
acknowledge receipt, keep the exact raw body and the result, and investigate on our side,
where the evidence is. The partial index `webhook_events_unresolved_idx` is that queue.

**The two exceptions.** A webhook that is genuinely signed but not JSON, or has no event
id, gets `400` and is *not* stored: we have nothing to key it on. The provider will retry
it, which is acceptable: that is a bug on their side, it is visible in their delivery logs,
and a few retries of a malformed message cost nothing. And an unexpected error (bug, DB
down) gets `500` with everything rolled back, so the retry does the work.

---

## 5. Every rule and the bug it prevents

### Database (migration 004)

| Constraint | Bug it prevents |
|---|---|
| `accounts_one_bank_settlement_per_currency` (partial unique index) | two settlement accounts for one currency; settlement reports split across them. The seed uses it as a safety net too. |
| `topups` PK on `transaction_id` | two provider payments attached to one top-up: one confirmation credits, the second credits again |
| `topups_provider_payment_id_key` UNIQUE | one payment confirming two top-ups: the user pays once, we credit twice (test 22) |
| `topups_account_currency_fkey` | a top-up in USD onto an INR account |
| `topups_amount_positive` | a zero expectation any webhook would "match" |
| trigger `topups_only_for_pending_topup` | linking a payment to a transfer, or to a top-up that is already posted/failed (test 22) |
| trigger `topups_no_update_or_delete` | changing the expected amount after the fact so a mismatched webhook passes; owner included (test 19) |
| `webhook_events` PK on `provider_event_id` | the same delivery credited twice (tests 3, 4) |
| `webhook_events_result_valid` | a result string the investigation queries don't understand |
| `webhook_events_applied_results_have_topup` | a `posted` event with no record of what it posted |
| trigger `webhook_events_no_update_or_delete` | rewriting the audit trail of what the provider said; owner included (test 20) |
| grants: INSERT only on the columns the app fills, timestamps by the database | the app backdating `received_at` or inventing `created_at` (test 21) |

### Code

| Rule | Bug it prevents |
|---|---|
| HMAC over raw bytes, timestamp inside the HMAC, 5 min max age, 30 s future tolerance | forged, tampered and replayed webhooks (test 5) |
| `timingSafeEqual` | brute-forcing a signature through response timing |
| event id checked first, `FOR UPDATE` on the transaction row, event insert with `ON CONFLICT DO NOTHING`, one transaction | duplicates and concurrent duplicates credited twice (tests 3, 4) |
| `status != pending` → `ignored_already_final` | a late `succeeded` resurrecting a failed top-up, or a late `failed` reversing a posted one (test 7) |
| amount/currency compared to the `topups` row, never trusted from the webhook | the provider (or a bug there) confirming ₹250 as ₹2,500 (test 8) |
| `unmatched` stored and acknowledged | an orphan payment vanishing without trace, or an endless retry loop (test 9) |
| ROLLBACK on any unexpected error | a top-up half-posted (entries without balance change, or event recorded without entries) (test 10) |
| `lockAccounts` shared with transfers | a transfer and a top-up on the same account deadlocking (test 15) |
| provider call with a 3 s timeout, `ProviderError` → 502, nothing stored | a hanging provider pinning a DB connection forever (test 12) |
| top-ups only onto `user` accounts, only in currencies with a settlement account | a payment we could never post (test 13) |

---

## 6. Two trade-offs you should know about

### The provider call runs inside the database transaction

`POST /topups` claims the idempotency key, inserts the pending transaction, **then calls
the provider over the network**, then inserts the `topups` row, then commits. Doing the
network call inside the transaction is what makes the bookkeeping airtight: if the
provider call fails, everything rolls back and the client's retry (same key) starts clean;
if the provider succeeds but our COMMIT fails, the provider's later webhook finds no
matching top-up and lands as `unmatched`, with `reference` pointing at the lost topup id.

The cost: for the duration of the call, this request holds a pool connection and the row
lock on its idempotency key. A slow provider (say, 2.9 s per call) would let 10 concurrent
top-ups pin the whole pool. The 3 s timeout caps the damage; it doesn't remove it.
**The fix is step 5:** `POST /topups` will only write the pending transaction and an
*outbox* row, and a separate worker will call the provider outside any transaction and
record the paymentId when it answers. That is the reason the outbox pattern exists.

### `bank_settlement` is a hot row

Every top-up in a currency locks the same `bank_settlement` row. Top-ups are therefore
serialised per currency: a thousand concurrent top-ups become a queue of a thousand short
lock waits on one row. At our scale that's fine (each hold is a few milliseconds). At real
scale it is the first thing that would need to change, with the usual options being many
settlement sub-accounts (sharding the hot row), or deferring the settlement-side balance
update to a batch. We keep one row because it keeps reconciliation trivially simple, and
because the shared `lockAccounts` ordering means it can never deadlock with transfers
(test 15).

---

## 7. The mock provider

`mock-provider/provider.ts` is a stand-in for Stripe/Razorpay with no HTTP of its own: a
`Map` of payments, `createPayment`, `settle(paymentId, outcome, { times, delayMs })`,
`deliver` (one signed POST) and `deliverWithRetry` (at-least-once with backoff).
`mock-provider/server.ts` wraps it for local use (`npm run provider`). It has its own copy
of the signing function on purpose: the folder must stay self-contained so it can leave the
repo (a Lambda, say) without taking ledger code with it.

---

## 8. Eight questions to answer before moving on

1. Why is the timestamp part of the signed text, and what attack works if you sign only the body?
2. The webhook route is mounted before `express.json()`. What exactly would go wrong if it weren't, and why wouldn't a test with a simple body notice?
3. Two deliveries of the same event arrive at the same instant. Trace both through `processWebhookEvent`: where does the second one block, what does it compute after it unblocks, and why does its work still get thrown away?
4. A `payment.succeeded` arrives for a top-up that is already `failed`. What does the ledger answer, and why is that answer `200` rather than `409`?
5. The provider confirms ₹2,500 for a top-up we recorded as ₹250. Which exact value ends up in the user's balance, and what prevents the webhook's number from being used?
6. Why does an unknown paymentId get `200`, but a genuine webhook with no event id gets `400`? What is the difference in what a retry can achieve?
7. Walk through what each party sees if the provider accepts `POST /payments` but our `COMMIT` fails right after. How is the money eventually traced?
8. A transfer out of account A and a top-up onto A run at the same time. Name the two lock sets, the order each takes them in, and why that order cannot form a cycle. What changes when ten thousand users top up in the same minute?
