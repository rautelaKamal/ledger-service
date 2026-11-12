# ledger-service

A double-entry ledger service built with Node 22, TypeScript, Express and raw SQL on
Postgres 17. Every movement of money is a **transaction** made of **entries** (debits and
credits). The database itself guarantees the ledger's core rules. Entries are
append-only, every transaction balances at COMMIT, user balances never go negative, and
currencies can't be mixed. Application bugs therefore can't corrupt the books. Money is
always stored as integer paise (`BIGINT`). Step 1 sets up the schema, those guarantees,
their tests and a `/health` endpoint. See [docs/STEP-01-EXPLAINED.md](docs/STEP-01-EXPLAINED.md).

## Run it locally (Node 22 + Docker)

```bash
npm install
cp .env.example .env && cp .env.test.example .env.test
npm run db:up        # Postgres 17 in Docker; first start creates roles + databases
npm run migrate      # applies migrations/*.sql to the `ledger` database
npm test             # migrates + truncates `ledger_test`, then runs every test
```

If your database volume predates step 5, create the two new roles first:
`npm run db:roles` (safe to re-run), then `npm run migrate`.

Then `npm run dev` starts the API on http://localhost:3000. `GET /health` returns 200 when
the database is reachable.

## Scripts

| Script              | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `npm run db:up`     | Start Postgres and wait until it is healthy                    |
| `npm run db:down`   | Stop Postgres (data is kept in the `ledger_pgdata` volume)     |
| `npm run db:roles`  | (Re)create the database roles on an existing volume; idempotent |
| `npm run migrate`   | Apply new SQL migrations as `ledger_owner`                     |
| `npm run dev`       | Run the API with auto-reload                                   |
| `npm run demo:race` | Watch two concurrency bugs happen, then `transfer()` avoid them |
| `npm run demo:retry`| Send one transfer 5 times with one key, then with 5 keys        |
| `npm run demo:webhooks` | One top-up, confirmed 5 times plus one forged webhook       |
| `npm run provider`  | Run the mock payment provider + notification sink on port 4100 |
| `npm run worker`    | Run the outbox worker (several copies may run at once)         |
| `npm run reconcile` | Check the books; exit 1 and list problems if anything is off   |
| `npm run demo:outbox` | A top-up whose worker is killed mid-flight, then recovers    |
| `npm run typecheck` | TypeScript type check, no output files                         |
| `npm test`          | Run the tests against the real `ledger_test` database          |

## API

### `POST /transfers`

Moves money between two accounts of the same currency. Safe to retry: send the same
`Idempotency-Key` and you get the first answer back instead of a second transfer.

| Header | Required | Meaning |
|---|---|---|
| `Idempotency-Key` | yes (1–255 chars) | Unique per intended transfer; reuse it on retries. Keys expire after 24 h. |
| `X-Client-Id` | yes | Who is calling. Keys are scoped per client. **A stand-in for authentication**, which a later step adds. |
| `Content-Type` | `application/json` | |

Body (no extra fields allowed):

```json
{ "fromAccountId": "<uuid>", "toAccountId": "<uuid>", "amountPaise": "2500", "note": "optional" }
```

`amountPaise` is a **string** holding a positive integer (`^[1-9][0-9]*$`) so the amount
never passes through a floating-point number.

```bash
curl -i -X POST http://localhost:3000/transfers \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Id: demo' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"fromAccountId":"<uuid>","toAccountId":"<uuid>","amountPaise":"2500","note":"rent"}'
```

| Status | When |
|---|---|
| `201 { "transactionId": … }` | money moved (or, with `Idempotent-Replayed: true`, moved earlier under this key) |
| `400` | invalid body or amount, same account, missing `Idempotency-Key` |
| `401` | missing `X-Client-Id` |
| `404` | an account does not exist |
| `409` + `Retry-After: 1` | the first request with this key is still running after 5 s (configurable) |
| `422` | insufficient funds, currency mismatch, or this key was already used for a different request |
| `500` | unexpected; nothing was stored, retry with the same key |

Errors look like `{ "error": { "code": "insufficient_funds", "message": "…" } }`.
See [docs/STEP-03-EXPLAINED.md](docs/STEP-03-EXPLAINED.md).

### `POST /topups` and `POST /webhooks/provider`: money coming in

A top-up is **not** credited when requested. It is credited when the payment provider
confirms it by a signed webhook. Locally the provider is `mock-provider/` (`npm run provider`).

```bash
# Terminals: database, API, mock provider (+ notification sink), outbox worker
npm run db:up && npm run migrate
npm run dev
npm run provider          # separate terminal; reads PROVIDER_PORT / WEBHOOK_SECRET / LEDGER_WEBHOOK_URL from .env
npm run worker            # separate terminal; calls the provider and delivers events (reads WORKER_* / PROVIDER_URL / NOTIFICATION_SINK_URL)

# 1. Ask for a top-up of ₹250.00 (same headers as /transfers). Nothing is credited yet.
curl -i -X POST http://localhost:3000/topups \
  -H 'Content-Type: application/json' -H 'X-Client-Id: demo' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"accountId":"<user account uuid>","amountPaise":"25000"}'
#   202 { "topupId": "<uuid>", "status": "pending" }
#   The request did not call the provider; the worker does, within a second.

# 2. Find the provider's paymentId for it (recorded by the worker)
psql "$DATABASE_URL" -c "select provider_payment_id from topups where transaction_id = '<topupId>'"

# 3. Tell the mock provider the payment succeeded; it sends the signed webhook to the API
curl -X POST http://localhost:4100/payments/<paymentId>/succeed -H 'Content-Type: application/json' -d '{"times": 3}'
#   the API answers 200 { received: true, result: "posted" } once, then duplicate: true

# Try /fail then /succeed for an out-of-order pair, or any amount of times for duplicates.
```

| Status (POST /topups) | When |
|---|---|
| `202 { topupId, status: "pending" }` | top-up recorded and the provider call queued; money arrives by webhook |
| `404` / `422` | unknown account; not a user account; currency with no settlement account |

| Status (POST /webhooks/provider) | When |
|---|---|
| `200 { received: true, result }` | applied (`posted`, `failed`) or recorded (`ignored_already_final`, `anomaly_amount_mismatch`, `unmatched`, `ignored_unknown_type`) |
| `200 { received: true, duplicate: true }` | this event id was already processed |
| `401` | signature missing, wrong, or timestamp outside the window; nothing stored |
| `400` | signed but not JSON / no event id; nothing stored, the provider retries |
| `500` | unexpected; everything rolled back, the provider retries |

`WEBHOOK_SECRET` must be the same value for the API and the provider. See
[docs/STEP-04-EXPLAINED.md](docs/STEP-04-EXPLAINED.md) and, for the worker and reconciliation,
[docs/STEP-05-EXPLAINED.md](docs/STEP-05-EXPLAINED.md).

## Port 5432 already in use?

If another Postgres already listens on 5432, set `POSTGRES_PORT=5434` (or any free port) in
`.env`, and change `5432` to that port in the URLs in `.env` and `.env.test`.

## Resetting the database

`db/init/00-roles.sql` creates the roles and databases. Docker runs it **only when the
data volume is empty**. If you change that file, or want a completely fresh database,
delete the volume:

```bash
npm run db:down -- -v   # same as: docker compose down -v  (deletes all local data)
npm run db:up
npm run migrate
```

**After any Docker reset** (a new volume, or Docker Desktop wiped its data) the `ledger`
database is empty again. Always run:

```bash
npm run db:up && npm run migrate
```

`npm test` migrates `ledger_test` by itself, but `npm run dev` needs `ledger` migrated.
