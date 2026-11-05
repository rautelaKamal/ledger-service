-- db/init/00-roles.sql
-- Runs as the postgres SUPERUSER, once per fresh cluster:
--   * locally: docker runs every file in /docker-entrypoint-initdb.d on an empty volume
--   * in CI:   a workflow step runs it with psql
--
-- Why not in a migration? Roles and databases belong to the whole Postgres
-- server (cluster), not to one database, and creating them needs superuser
-- rights. Migrations run as ledger_owner, which deliberately cannot do this.
--
-- The passwords below are LOCAL/CI-ONLY values. Real environments must create
-- these roles with real secrets, outside of git.

-- Owns the schema and runs migrations. Cannot create roles or databases.
CREATE ROLE ledger_owner LOGIN PASSWORD 'ledger_owner_local'
    NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- What the API connects as. Gets only the grants listed in migration 001.
CREATE ROLE ledger_app LOGIN PASSWORD 'ledger_app_local'
    NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- One database for development, one for the test suite.
-- Owned by ledger_owner, so ledger_owner also owns their `public` schema.
CREATE DATABASE ledger      OWNER ledger_owner;
CREATE DATABASE ledger_test OWNER ledger_owner;

-- By default every role may CONNECT to every database. Restrict that.
REVOKE CONNECT ON DATABASE ledger, ledger_test FROM PUBLIC;
GRANT  CONNECT ON DATABASE ledger, ledger_test TO ledger_owner, ledger_app;
