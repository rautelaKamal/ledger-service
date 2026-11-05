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
npm test             # migrates + truncates `ledger_test`, then runs the DB guarantee tests
```

Then `npm run dev` starts the API on http://localhost:3000. `GET /health` returns 200 when
the database is reachable.

## Scripts

| Script              | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `npm run db:up`     | Start Postgres and wait until it is healthy                    |
| `npm run db:down`   | Stop Postgres (data is kept in the `ledger_pgdata` volume)     |
| `npm run migrate`   | Apply new SQL migrations as `ledger_owner`                     |
| `npm run dev`       | Run the API with auto-reload                                   |
| `npm run typecheck` | TypeScript type check, no output files                         |
| `npm test`          | Run the tests against the real `ledger_test` database          |

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
