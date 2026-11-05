# Step 1, explained

This step builds the foundation of the ledger: three tables, the rules that protect them,
the database roles that limit who can do what, and tests that prove each rule really works.
There is no transfer logic yet. You will write that in step 2 on top of these guarantees.

---

## 1. Double-entry, using a khata

Picture the shopkeeper's **khata**, the ledger book at a kirana shop. When Ramesh buys
₹500 of groceries on credit, the shopkeeper doesn't just write "Ramesh −500". Every
movement of value is written **twice**, on two sides:

| Date  | Entry                       | Debit (Dr) | Credit (Cr) |
| ----- | --------------------------- | ---------: | ----------: |
| 5 Nov | Ramesh's account            |       ₹500 |             |
| 5 Nov | Shop's sales                |            |        ₹500 |

The two sides of every line-group must be equal. If at the end of the day the debit column
and the credit column don't add up to the same number, the shopkeeper knows a mistake
was made, before the money disappears.

Our tables map to the khata like this:

| Khata                                     | Our database                                             |
| ----------------------------------------- | -------------------------------------------------------- |
| A page per person or purpose ("Ramesh", "Sales") | a row in `accounts`                               |
| One event ("Ramesh bought groceries")    | a row in `transactions`                                   |
| Each line under that event, Dr or Cr     | a row in `entries` (`direction` = `debit` / `credit`)     |
| "Dr total = Cr total" check              | the deferred balance trigger, run at COMMIT               |
| Writing in pen, never erasing            | the append-only trigger on `entries`                      |
| Running total at the top of each page    | `accounts.balance_paise` (a cached number, see "Known gap") |

The shopkeeper never uses an eraser. A mistake is fixed by writing a **new, reversing
line**. Our `entries` table works the same way.

---

## 2. Money is integer paise

₹123.45 is stored as `12345` in a `BIGINT` column. Never `FLOAT`, because `0.1 + 0.2 !==
0.3` in floating point and a ledger cannot be "almost right". Never `NUMERIC` rupees either:
one unit (paise) everywhere means no rounding decisions anywhere.

**In TypeScript we read BIGINT as `bigint`** (see [src/db.ts](../src/db.ts)):

- A JS `number` is only exact up to 2^53 ≈ 9 × 10^15. BIGINT goes to 9.2 × 10^18. A number
  silently rounds above 2^53, which is the worst possible failure for money.
- `pg` returns BIGINT as a `string` by default. Strings are safe but awkward:
  `"100" + "50"` is `"10050"`.
- `bigint` does exact integer math (`100n + 50n === 150n`). TypeScript refuses to mix it
  with `number` (`100n + 0.5` is a compile error).
- `JSON.stringify(10n)` throws. That's good here: when we build API responses we must
  consciously convert money to a string, so it can never be sent as a lossy JS number.

---

## 3. Every file, what it is and why it exists

| File | What it is | Why it exists |
| ---- | ---------- | ------------- |
| `package.json` | Project manifest: dependencies and npm scripts. | `npm run db:up / db:down / migrate / dev / typecheck / test` are the only commands you need. |
| `package-lock.json` | Exact versions of every installed package. | CI (`npm ci`) installs exactly what you tested locally. |
| `tsconfig.json` | TypeScript compiler settings (`strict`, `NodeNext`, `noEmit`). | Strict typing catches mistakes at compile time. `noEmit` because `tsx` runs `.ts` directly. Imports end in `.js` because that's how Node ESM resolves files (`NodeNext`). |
| `.nvmrc` | Says "Node 22". | `nvm use` picks the right Node version. |
| `.gitignore` | Files git must never track. | Keeps `node_modules/`, `.env` and `.env.test` (which hold passwords) out of the repo. |
| `.env.example` | Template for `.env` (dev database `ledger`). | Shows which variables exist. Contains **local-only** values. You copy it to `.env`. |
| `.env.test.example` | Template for `.env.test` (test database `ledger_test`). | Same variable names, different database, so tests never touch your dev data. |
| `docker-compose.yml` | Runs Postgres 17 (`pgvector/pgvector:pg17`) with a named volume and a healthcheck. | Everyone gets the same database. The volume keeps data across restarts. The healthcheck lets `db:up` wait until Postgres is actually ready. The host port comes from `POSTGRES_PORT` (default 5432) in case another project already uses 5432. |
| `db/init/00-roles.sql` | Creates the roles `ledger_owner` and `ledger_app` and the databases `ledger` and `ledger_test`. Runs as superuser. | Roles and databases belong to the whole server, and creating them needs superuser rights, which the migration role must not have. Docker runs this file only on an **empty volume**. CI runs it with `psql`. |
| `migrations/001_ledger_core.sql` | Tables, constraints, triggers and grants. | The schema lives in versioned, reviewable SQL. |
| `scripts/migrate.ts` | ~50-line migration runner. | Applies each new `.sql` file in its **own** `BEGIN … COMMIT`, together with the row in `schema_migrations` that records it. A half-applied migration is impossible. |
| `src/config.ts` | Reads and validates env vars with zod. | The app crashes at startup with a clear message instead of failing on the first query. |
| `src/db.ts` | Creates the `pg` connection pool and sets the BIGINT → `bigint` parser. | One place decides how money comes out of the database. |
| `src/app.ts` | The Express app with `GET /health`. | Returns 200 only if `SELECT 1` succeeds, so a load balancer or Kubernetes won't send traffic to an instance whose database is down. Kept separate from `server.ts` so it can be tested without opening a port. |
| `src/server.ts` | Starts the HTTP server and shuts down cleanly on Ctrl+C or SIGTERM. | Entry point for `npm run dev`. |
| `vitest.config.ts` | Test runner settings. | Registers the global setup and env loader, and turns off parallel test files (see section 7). |
| `tests/load-env.ts` | Loads `.env.test` with Node's built-in `process.loadEnvFile`. | Vitest does not put non-`VITE_` variables from env files into `process.env`. No `dotenv` needed. |
| `tests/global-setup.ts` | Runs once before all tests: migrates `ledger_test`, then `TRUNCATE`s the tables as the owner. | Gives every test run a clean, up-to-date database. Refuses to run against a database whose name doesn't end in `_test`. |
| `tests/helpers.ts` | Small helpers: create account/transaction/entry, `withRollback`, error codes. | Keeps each test focused on the one rule it proves. |
| `tests/db-guarantees.test.ts` | Eight tests, one rule each. | Proof that the database, not the app, enforces the rules. |
| `.github/workflows/ci.yml` | CI on every push and PR: Postgres service, init SQL, migrate, typecheck, test. | Every change is checked against a real Postgres. |
| `README.md` | What this is and how to run it. | The front door. |
| `docs/STEP-01-EXPLAINED.md` | This file. | So you understand every decision. |

---

## 4. Every constraint and trigger, and the money bug it prevents

### accounts

| Rule | Bug it prevents | Tiny example |
| ---- | --------------- | ------------ |
| `balance_paise BIGINT` | Rounding errors from floats. | With floats, ₹0.10 + ₹0.20 = ₹0.30000000000000004. With paise it's 10 + 20 = 30. |
| `accounts_kind_valid`: `kind IN ('user','system')` | A typo like `'usr'` slipping past the "users can't go negative" rule. | `INSERT … kind='usr'` is rejected. |
| `accounts_currency_format`: three capital letters | `'inr'`, `'Rs'` and `'INR'` being treated as different currencies. | `currency='inr'` is rejected. |
| `accounts_user_balance_not_negative` | A customer spending money they don't have, e.g. two withdrawals racing each other. | User has ₹100. `UPDATE … SET balance_paise = -5000` is rejected. Bank settlement (system) at −₹500 is allowed, because it represents money owed by the bank. |
| `accounts_id_currency_key`: `UNIQUE (id, currency)` | Nothing alone. It is the target the composite foreign key below needs. | — |

### transactions

| Rule | Bug it prevents | Tiny example |
| ---- | --------------- | ------------ |
| `transactions_kind_valid` | Unknown transaction types that reports and the AI assistant can't interpret. | `kind='gift'` is rejected. |
| `transactions_status_valid` | A status like `'done'` that no code path understands. | `status='done'` is rejected. |
| `transactions_posted_at_matches_status` | "Posted" with no posting time, or a posting time on a failed transaction. Statements and audits would be wrong. | `status='posted', posted_at=NULL` is rejected. |
| Trigger `transactions_final_is_frozen` | Changing history after the fact, e.g. turning a posted transfer into "failed" so the money looks like it never moved. | A posted transaction gets `UPDATE … SET status='failed'`. Error: *"transaction … is posted and can no longer be changed"*. |

### entries

| Rule | Bug it prevents | Tiny example |
| ---- | --------------- | ------------ |
| `entries_amount_positive`: `amount_paise > 0` | A negative credit secretly acting as a debit, and zero-value "noise" entries. Direction is carried **only** by `direction`. | `amount_paise = -500` or `0` is rejected. |
| `entries_direction_valid` | Entries counted in neither column. | `direction='dr'` is rejected. |
| `entries_transaction_fkey` | Orphan entries that belong to no transaction. | An entry for a random `transaction_id` is rejected. |
| `entries_account_currency_fkey`: `(account_id, currency)` → `accounts(id, currency)` | Mixing currencies: crediting 100 **USD** to an **INR** account turns $1 into ₹1. | Entry with `currency='USD'` on an INR account is rejected with a foreign key violation. |
| Trigger `entries_no_update_or_delete` (append-only) | Silently editing or erasing a line of the khata. Even a buggy owner script can't rewrite history. | `UPDATE entries SET amount_paise = 1` by the owner fails with *"entries are append-only: UPDATE is not allowed"*. |
| Constraint trigger `entries_transaction_must_balance` (`DEFERRABLE INITIALLY DEFERRED`) | Money created or destroyed: debit ₹100 from one account, credit only ₹90 to another, and ₹10 vanishes. | Debit 10000 + credit 9000 inserts fine, then `COMMIT` fails: *"unbalanced in INR: debits 10000 <> credits 9000"*. The whole transaction is rolled back. |

**Why deferred?** You insert entries one at a time. Right after the debit and before the
credit, the transaction is *temporarily* unbalanced, and that's fine. "Initially
deferred" means "check at COMMIT, not after each row". **Why per currency?** Debit 100
INR + credit 100 USD would otherwise look balanced.

**Indexes** on `entries(transaction_id)` and `entries(account_id)`: the balance check looks
entries up by transaction, and statements look them up by account. Without indexes,
both would scan the whole table.

---

## 5. Roles and grants

| Role | Used by | Can |
| ---- | ------- | --- |
| `postgres` | `db/init/00-roles.sql` only | Everything (superuser). Never used by the app. |
| `ledger_owner` | migrations, test setup | Owns the tables: create and alter them, TRUNCATE. Cannot create roles or databases. |
| `ledger_app` | the API | Only what's listed below. |

`ledger_app` grants (from the migration):

- `SELECT` on all three tables
- `INSERT (name, kind, currency)` on `accounts`
- `INSERT (kind, status, note, posted_at)` on `transactions`
- `INSERT (transaction_id, account_id, currency, direction, amount_paise)` on `entries`
- `UPDATE (balance_paise)` on `accounts`, `UPDATE (status, posted_at)` on `transactions`
- **No** `DELETE`, **no** `TRUNCATE`, **no** `UPDATE` on `entries`

The app inserts only the columns it needs. The **database** fills `id`, `created_at` and
the starting balance (0), and the app reads new ids back with `RETURNING id`. Two bugs this
prevents:

- **Money from nothing.** `INSERT INTO accounts (…, balance_paise) VALUES (…, 100000000)`
  gives you a permission error.
- **Backdating.** `INSERT INTO entries (…, created_at) VALUES (…, '2020-01-01')` gives you a
  permission error.

The app also can't change `accounts.kind`, so a user account can't be "promoted" to
`system` to escape the no-negative rule.

**Grants are the security boundary; triggers are guardrails against bugs.**

The owner can always disable a trigger (`ALTER TABLE … DISABLE TRIGGER`), so triggers do
not stop a determined owner. They stop *mistakes*. What actually stops the API (or an
attacker who controls the API) is that `ledger_app` simply lacks the privilege. That's
why there is no TRUNCATE trigger: `ledger_app` has no TRUNCATE privilege, which is the
real protection, and the owner needs TRUNCATE to reset the test database.

**Why roles live in `db/init/00-roles.sql` and not in a migration:** roles and databases
are cluster-wide, and creating them needs superuser rights. Migrations run per database
(`ledger` *and* `ledger_test`) as `ledger_owner`, which can't create roles, and *should*
not be able to.

---

## 6. Migrations

`npm run migrate` connects as `ledger_owner` (`OWNER_DATABASE_URL`) and:

1. creates `schema_migrations` if it doesn't exist
2. lists `migrations/*.sql` in name order (`001_…`, `002_…`)
3. for each file not yet recorded, runs `BEGIN`, then the file, then
   `INSERT INTO schema_migrations`, then `COMMIT`. If anything fails it runs `ROLLBACK`
   and stops.

Rule: never edit a migration that has already been applied anywhere. Add a new file.

---

## 7. How the tests work, and why they're isolated this way

Tests run against a **real** Postgres database (`ledger_test`). There are no mocks, because
the whole point is to prove that Postgres enforces the rules.

**The cleanup trap.** The usual trick, "wrap each test in a transaction and roll back",
doesn't work for us everywhere:

- the balance rule only fires at **COMMIT**, so test 3 must really commit
- entries are append-only, so test code **can't `DELETE`** what it committed

**What we do instead:**

1. `tests/global-setup.ts` runs once before the run, as `ledger_owner`. It applies
   migrations, then runs `TRUNCATE entries, transactions, accounts`. TRUNCATE doesn't fire
   row-level DELETE triggers, and only the owner has the privilege (test 7 proves the app
   doesn't).
2. Each test creates its **own** accounts (new UUIDs), so tests don't share rows and don't
   depend on running order.
3. Tests that only need to see a rejection use `withRollback` (`BEGIN … ROLLBACK`). Tests
   that must commit leave rows behind; the next run's TRUNCATE removes them.

**Why test files run one after another** (`fileParallelism: false`): every file uses the
same `ledger_test` database, and the TRUNCATE happens once for the whole run. If two files
ran at the same time, one file's committed rows would be visible to the other's queries.
Any future per-file cleanup could also wipe rows another file is in the middle of using.
Running files sequentially is slower but deterministic.

**Env loading:** `npm test` doesn't use `--env-file`. `tests/load-env.ts` calls
`process.loadEnvFile('.env.test')` when that file exists (locally). In CI the workflow sets
`DATABASE_URL` and `OWNER_DATABASE_URL` directly. The global setup refuses to run unless
the database name ends in `_test`, because it TRUNCATEs tables.

| # | Test (plain English) | Connects as |
| - | -------------------- | ----------- |
| 1 | an entry with an amount of zero or a negative amount is rejected | app |
| 2 | the app cannot UPDATE or DELETE an entry, and even the owner is blocked by the trigger | app + owner |
| 3 | a transaction whose debits don't equal its credits fails at COMMIT, and a balanced one commits | app |
| 4 | a user account's balance cannot go below 0, but a system account's can | app |
| 5 | an entry whose currency differs from its account's currency is rejected | app |
| 6 | a posted transaction's status cannot be changed | app |
| 7 | the app role cannot TRUNCATE entries | app |
| 8 | the app cannot choose an account's starting balance or an entry's created_at | app |

---

## 8. Known gap

`ledger_app` can still `UPDATE accounts SET balance_paise = <any value ≥ 0>`, and the
value can be **wrong**. Nothing in the database checks that `balance_paise` equals
(credits − debits) of that account's entries. For example, a bug in step 2's transfer code
could add ₹100 to the balance while writing entries for ₹10. Every constraint would pass.

This is deliberately not fixed now. The **reconciliation job** in a later step will
recompute each account's balance from its entries (the source of truth) and compare it with
the cached `balance_paise`. Any mismatch is detected and reported. Entries are the truth;
`balance_paise` is a fast cache of it.

Other things not enforced yet, for later steps:

- A transaction with **zero** entries can be committed. The balance trigger only fires
  when an entry is inserted.
- Entries can still be added to a transaction that is already `posted`.
- The app can insert a transaction that is already `posted`.

> **Update (step 2):** migration 002 closes these three. See
> [STEP-02-NOTES.md](STEP-02-NOTES.md). The first gap (a wrong cached `balance_paise`)
> is still open until the reconciliation job exists.

---

## 9. Questions you should be able to answer

1. Why does the balance check have to be `DEFERRABLE INITIALLY DEFERRED`? What would happen to a normal two-entry transfer if it weren't?
2. Why is `UNIQUE (id, currency)` on `accounts` needed when `id` is already the primary key?
3. Test 2 expects two *different* errors for `ledger_app` and `ledger_owner`. Why, and which of the two is the real security boundary?
4. Why can't the tests just wrap every test in `BEGIN … ROLLBACK` and skip the TRUNCATE?
5. Why are roles created in `db/init/00-roles.sql` rather than in `migrations/001_ledger_core.sql`?
6. What could go wrong if BIGINT values were read into JavaScript `number`s? Give an amount where it breaks.
7. Why is `amount_paise` always positive, with the sign carried by `direction`, instead of storing signed amounts?
8. The "Known gap" says `balance_paise` can be wrong. If entries are the source of truth, why keep a cached balance at all?
