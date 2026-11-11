-- migrations/002_transaction_lifecycle.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.
--
-- Lifecycle of every transaction, all inside ONE database transaction:
--   1. INSERT INTO transactions (kind, note)          -> status 'pending' (default)
--   2. INSERT INTO entries (...)                       -> only while 'pending'
--   3. UPDATE transactions SET status = 'posted'       -> needs >= 2 entries;
--                                                         database stamps posted_at
--   COMMIT -> deferred checks: debits = credits (001), transaction is posted (rule 6).
-- A transaction that never got entries may instead become 'failed'.
-- Result: a transaction has entries if and only if it is posted.

-- ───────────── Rule 1: a new transaction always starts as 'pending' ─────────────
-- ledger_app keeps INSERT (kind, note). status falls back to its DEFAULT 'pending',
-- posted_at to NULL.
REVOKE INSERT (status, posted_at) ON transactions FROM ledger_app;

-- ───────────── Rule 5: only the database sets posted_at ─────────────
-- ledger_app keeps UPDATE (status). posted_at is stamped by the trigger below.
-- The 001 CHECK transactions_posted_at_matches_status stays in place:
-- posted_at IS NOT NULL exactly when status = 'posted'.
REVOKE UPDATE (posted_at) ON transactions FROM ledger_app;

-- ───────────── Rule 2: entries only for a 'pending' transaction ─────────────
-- NOTE: SELECT ... FOR SHARE requires the caller to hold UPDATE on at least one
-- column of transactions. This trigger runs as ledger_app, so rule 2 depends on
-- ledger_app keeping UPDATE (status).
CREATE FUNCTION entries_require_pending_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    tx_status TEXT;
BEGIN
    -- FOR SHARE locks the transaction row until our COMMIT, so no other
    -- session can post or fail it between this check and our COMMIT.
    SELECT status INTO tx_status
      FROM transactions
     WHERE id = NEW.transaction_id
       FOR SHARE;

    IF NOT FOUND THEN
        RETURN NEW;  -- the foreign key will report the missing transaction
    END IF;

    IF tx_status <> 'pending' THEN
        RAISE EXCEPTION 'cannot add entries to transaction %: it is % (only pending transactions accept entries)',
            NEW.transaction_id, tx_status;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER entries_only_for_pending_transaction
    BEFORE INSERT ON entries
    FOR EACH ROW EXECUTE FUNCTION entries_require_pending_transaction();

-- ───────────── Rules 3, 4, 5: what a status change requires ─────────────
-- Triggers of the same kind fire in name order, so transactions_final_is_frozen (001)
-- runs first: by the time this runs, OLD.status is 'pending'.
CREATE FUNCTION transactions_check_status_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    entry_count BIGINT;
BEGIN
    -- Rule 5: nobody (not even the owner) writes posted_at directly.
    IF NEW.posted_at IS DISTINCT FROM OLD.posted_at THEN
        RAISE EXCEPTION 'posted_at is set by the database when a transaction is posted; do not set it directly';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        SELECT count(*) INTO entry_count
          FROM entries
         WHERE transaction_id = NEW.id;

        -- Rule 3
        IF NEW.status = 'posted' AND entry_count < 2 THEN
            RAISE EXCEPTION 'cannot post transaction %: it has % entries, at least 2 are required',
                NEW.id, entry_count;
        END IF;

        -- Rule 4
        IF NEW.status = 'failed' AND entry_count > 0 THEN
            RAISE EXCEPTION 'cannot mark transaction % as failed: it already has % entries',
                NEW.id, entry_count;
        END IF;

        -- Rule 5: stamped exactly when the status becomes 'posted'.
        IF NEW.status = 'posted' THEN
            NEW.posted_at := now();
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_status_change_rules
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_check_status_change();

-- ───────────── Rule 6: at COMMIT, every transaction with entries is 'posted' ─────────────
-- Together with rule 3 (posting needs >= 2 entries) this gives:
-- a transaction has entries if and only if it is posted.
CREATE FUNCTION entries_check_transaction_posted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    tx_status TEXT;
BEGIN
    SELECT status INTO tx_status
      FROM transactions
     WHERE id = NEW.transaction_id;

    IF tx_status IS DISTINCT FROM 'posted' THEN
        RAISE EXCEPTION 'transaction % has entries but is % at COMMIT; entries are only allowed on posted transactions',
            NEW.transaction_id, tx_status
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_transaction_must_be_posted
    AFTER INSERT ON entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION entries_check_transaction_posted();
