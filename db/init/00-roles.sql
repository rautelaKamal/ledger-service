-- db/init/00-roles.sql
-- Runs as the postgres SUPERUSER:
--   * locally: docker runs every file in /docker-entrypoint-initdb.d on an EMPTY volume,
--              and `npm run db:roles` re-runs it against an existing one
--   * in CI:   a workflow step runs it with psql
-- It is safe to run repeatedly: roles and databases are created only if missing.
--
-- Why not in a migration? Roles and databases belong to the whole Postgres
-- server (cluster), not to one database, and creating them needs superuser
-- rights. Migrations run as ledger_owner, which deliberately cannot do this.
--
-- The passwords below are LOCAL/CI-ONLY values. Real environments must create
-- these roles with real secrets, outside of git.

DO $$
BEGIN
    -- Owns the schema and runs migrations. Cannot create roles or databases.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_owner') THEN
        CREATE ROLE ledger_owner LOGIN PASSWORD 'ledger_owner_local' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    -- What the API connects as. Gets only the grants listed in the migrations.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
        CREATE ROLE ledger_app LOGIN PASSWORD 'ledger_app_local' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    -- The outbox worker: performs side effects, keeps delivery bookkeeping.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_worker') THEN
        CREATE ROLE ledger_worker LOGIN PASSWORD 'ledger_worker_local' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    -- The reconciliation job: reads everything it checks, writes one row per run.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_reconciler') THEN
        CREATE ROLE ledger_reconciler LOGIN PASSWORD 'ledger_reconciler_local' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
END;
$$;

-- One database for development, one for the test suite, owned by ledger_owner.
-- (CREATE DATABASE cannot run inside DO/transactions, so psql's \gexec runs it.)
SELECT 'CREATE DATABASE ledger OWNER ledger_owner'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ledger') \gexec
SELECT 'CREATE DATABASE ledger_test OWNER ledger_owner'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ledger_test') \gexec

-- By default every role may CONNECT to every database. Restrict that.
REVOKE CONNECT ON DATABASE ledger, ledger_test FROM PUBLIC;
GRANT  CONNECT ON DATABASE ledger, ledger_test TO ledger_owner, ledger_app, ledger_worker, ledger_reconciler;
