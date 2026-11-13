-- migrations/006_observability_grants.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.

-- /readyz: the API and the worker report "not ready" until every migration file
-- on disk is recorded here. They only need to read the filenames.
-- (schema_migrations is created by the migration runner, before any file runs.)
GRANT SELECT (filename) ON schema_migrations TO ledger_app, ledger_worker;

-- The worker exposes the LAST reconciliation result as metrics (the reconcile job
-- itself is short-lived; Prometheus cannot scrape a process that has exited).
-- Only the headline columns: which run, when, ok, and per-check counts.
-- Not the problems list.
GRANT SELECT (id, ran_at, ok, summary) ON reconciliation_runs TO ledger_worker;
