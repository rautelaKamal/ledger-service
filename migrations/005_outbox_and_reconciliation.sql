-- migrations/005_outbox_and_reconciliation.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.
--
-- Side effects (calling the provider, notifying other systems) must never run
-- inside a ledger transaction and must never be lost after COMMIT. So every
-- change that needs a side effect writes an outbox row IN THE SAME TRANSACTION,
-- and a separate worker (role ledger_worker) performs the side effect later.
-- A separate reconciliation job (role ledger_reconciler) checks the books.

-- ───────────── Guard: the background roles must exist ─────────────
-- Roles are cluster-wide and created by db/init/00-roles.sql (npm run db:roles).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_worker')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_reconciler') THEN
        RAISE EXCEPTION 'roles ledger_worker and ledger_reconciler must exist: run db/init/00-roles.sql first (npm run db:roles)';
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO ledger_worker, ledger_reconciler;

-- ───────────── outbox ─────────────
CREATE TABLE outbox (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- creation order = delivery order
    type         TEXT        NOT NULL,
    payload      JSONB       NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'pending',
    attempts     INTEGER     NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- moved into the future on failure (backoff)
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at      TIMESTAMPTZ,

    CONSTRAINT outbox_type_valid
        CHECK (type IN ('provider.create_payment', 'transfer.posted', 'topup.posted', 'topup.failed')),
    CONSTRAINT outbox_status_valid
        CHECK (status IN ('pending', 'sent', 'dead')),
    CONSTRAINT outbox_attempts_not_negative
        CHECK (attempts >= 0),
    -- sent_at exists exactly when the row is sent
    CONSTRAINT outbox_sent_at_matches_status
        CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
    -- a dead row always says why
    CONSTRAINT outbox_dead_has_error
        CHECK (status <> 'dead' OR last_error IS NOT NULL)
);

-- The poll query: pending rows that are due, oldest first.
CREATE INDEX outbox_pending_due_idx ON outbox (available_at, id) WHERE status = 'pending';

-- Rows are commands/facts: never edited except for delivery bookkeeping,
-- frozen once final, and only sent rows may ever be deleted (retention, later).
CREATE FUNCTION outbox_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'sent' THEN
            RAISE EXCEPTION 'outbox row % is % and cannot be deleted (only sent rows may be pruned)', OLD.id, OLD.status;
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.id         IS DISTINCT FROM OLD.id
    OR NEW.type       IS DISTINCT FROM OLD.type
    OR NEW.payload    IS DISTINCT FROM OLD.payload
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'outbox row %: id, type, payload and created_at are immutable', OLD.id;
    END IF;
    IF OLD.status IN ('sent', 'dead') THEN
        RAISE EXCEPTION 'outbox row % is already % and can no longer be changed', OLD.id, OLD.status;
    END IF;
    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'outbox row %: attempts cannot decrease (% -> %)', OLD.id, OLD.attempts, NEW.attempts;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_guard
    BEFORE UPDATE OR DELETE ON outbox
    FOR EACH ROW EXECUTE FUNCTION outbox_block_changes();

-- ───────────── topups: the paymentId is now recorded later, once ─────────────
-- POST /topups no longer calls the provider; the worker does, and records the
-- paymentId afterwards. Everything else about topups stays append-only.
ALTER TABLE topups ALTER COLUMN provider_payment_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION topups_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'topups are append-only: DELETE is not allowed';
    END IF;
    -- The single permitted change: provider_payment_id from NULL to a value.
    IF OLD.provider_payment_id IS NULL
       AND NEW.provider_payment_id IS NOT NULL
       AND NEW.transaction_id = OLD.transaction_id
       AND NEW.account_id     = OLD.account_id
       AND NEW.currency       = OLD.currency
       AND NEW.amount_paise   = OLD.amount_paise
       AND NEW.created_at     = OLD.created_at THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'topups are append-only: only provider_payment_id may be set, once, from NULL (top-up %)', OLD.transaction_id;
END;
$$;
-- (trigger topups_no_update_or_delete from 004 keeps pointing at this function)

-- The API no longer knows the paymentId; the worker records it.
REVOKE INSERT (provider_payment_id) ON topups FROM ledger_app;

-- ───────────── reconciliation_runs ─────────────
CREATE TABLE reconciliation_runs (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ok          BOOLEAN     NOT NULL,
    duration_ms INTEGER     NOT NULL,
    summary     JSONB       NOT NULL,   -- counts per check
    problems    JSONB       NOT NULL,   -- list of findings (capped)

    CONSTRAINT reconciliation_runs_duration_not_negative
        CHECK (duration_ms >= 0),
    CONSTRAINT reconciliation_runs_problems_is_array
        CHECK (jsonb_typeof(problems) = 'array'),
    -- ok means exactly "no problems found"
    CONSTRAINT reconciliation_runs_ok_matches_problems
        CHECK (ok = (jsonb_array_length(problems) = 0))
);

CREATE FUNCTION reconciliation_runs_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'reconciliation_runs are append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER reconciliation_runs_no_update_or_delete
    BEFORE UPDATE OR DELETE ON reconciliation_runs
    FOR EACH ROW EXECUTE FUNCTION reconciliation_runs_block_changes();

-- ───────────── Privileges ─────────────
-- The API may ask for work, nothing more: it cannot see or mark outbox rows.
GRANT INSERT (type, payload) ON outbox TO ledger_app;

-- The worker performs the work and keeps the books of delivery.
GRANT SELECT ON outbox TO ledger_worker;
GRANT UPDATE (status, attempts, available_at, last_error, sent_at) ON outbox TO ledger_worker;
GRANT SELECT ON topups TO ledger_worker;
GRANT UPDATE (provider_payment_id) ON topups TO ledger_worker;

-- The reconciler reads what it checks and writes one row per run.
GRANT SELECT ON accounts, transactions, entries, topups, webhook_events, outbox, reconciliation_runs
    TO ledger_reconciler;
GRANT INSERT (ok, duration_ms, summary, problems) ON reconciliation_runs TO ledger_reconciler;

-- Deliberately absent: DELETE for anyone; INSERT on outbox for the worker;
-- any SELECT on ledger tables for the worker; any UPDATE for the reconciler.
