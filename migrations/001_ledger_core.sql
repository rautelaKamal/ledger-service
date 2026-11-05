-- migrations/001_ledger_core.sql
-- Runs as ledger_owner. The migration runner wraps this file in BEGIN/COMMIT,
-- so either every statement below is applied or none is.
-- Requires the roles ledger_owner and ledger_app (created by db/init/00-roles.sql).

-- ───────────── Schema access ─────────────
-- Only roles we explicitly allow may even see objects in this schema.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ledger_app;

-- ───────────── accounts ─────────────
CREATE TABLE accounts (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    currency      CHAR(3)     NOT NULL,
    balance_paise BIGINT      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT accounts_kind_valid
        CHECK (kind IN ('user', 'system')),
    CONSTRAINT accounts_currency_format
        CHECK (currency ~ '^[A-Z]{3}$'),
    -- A user can never owe the ledger money; system accounts
    -- (e.g. bank settlement) may go negative.
    CONSTRAINT accounts_user_balance_not_negative
        CHECK (kind = 'system' OR balance_paise >= 0),
    -- id is already unique; this extra key exists only so entries
    -- can reference (account_id, currency) as a pair.
    CONSTRAINT accounts_id_currency_key
        UNIQUE (id, currency)
);

-- ───────────── transactions ─────────────
CREATE TABLE transactions (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       TEXT        NOT NULL,
    status     TEXT        NOT NULL DEFAULT 'pending',
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at  TIMESTAMPTZ,

    CONSTRAINT transactions_kind_valid
        CHECK (kind IN ('transfer', 'topup', 'refund')),
    CONSTRAINT transactions_status_valid
        CHECK (status IN ('pending', 'posted', 'failed')),
    -- posted_at is set if and only if the transaction is posted.
    CONSTRAINT transactions_posted_at_matches_status
        CHECK ((status = 'posted') = (posted_at IS NOT NULL))
);

-- ───────────── entries ─────────────
CREATE TABLE entries (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID        NOT NULL,
    account_id     UUID        NOT NULL,
    currency       CHAR(3)     NOT NULL,
    direction      TEXT        NOT NULL,
    amount_paise   BIGINT      NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT entries_direction_valid
        CHECK (direction IN ('debit', 'credit')),
    CONSTRAINT entries_amount_positive
        CHECK (amount_paise > 0),
    CONSTRAINT entries_transaction_fkey
        FOREIGN KEY (transaction_id) REFERENCES transactions (id),
    -- The entry's currency must equal its account's currency.
    CONSTRAINT entries_account_currency_fkey
        FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency)
);

CREATE INDEX entries_transaction_id_idx ON entries (transaction_id);
CREATE INDEX entries_account_id_idx     ON entries (account_id);

-- ───────────── Trigger: finished transactions are frozen ─────────────
CREATE FUNCTION transactions_block_update_when_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('posted', 'failed') THEN
        RAISE EXCEPTION 'transaction % is % and can no longer be changed',
            OLD.id, OLD.status;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_final_is_frozen
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_block_update_when_final();

-- ───────────── Trigger: entries are append-only ─────────────
-- Blocks UPDATE and DELETE for every role, including the owner.
-- TRUNCATE is NOT blocked by a trigger: ledger_app simply has no TRUNCATE
-- privilege (grants are the security boundary), and the owner needs TRUNCATE
-- to reset the test database.
CREATE FUNCTION entries_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'entries are append-only: % is not allowed (post a reversing transaction instead)',
        TG_OP;
END;
$$;

CREATE TRIGGER entries_no_update_or_delete
    BEFORE UPDATE OR DELETE ON entries
    FOR EACH ROW EXECUTE FUNCTION entries_block_changes();

-- ───────────── Constraint trigger: debits = credits, checked at COMMIT ─────────────
-- Fires once per inserted entry, but only when the transaction COMMITs
-- (INITIALLY DEFERRED), so the debit and the credit can be inserted one by one.
-- Checked per currency, so "100 INR debit + 100 USD credit" is NOT balanced.
CREATE FUNCTION entries_check_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    bad RECORD;
BEGIN
    SELECT currency,
           COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'),  0) AS debits,
           COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0) AS credits
      INTO bad
      FROM entries
     WHERE transaction_id = NEW.transaction_id
     GROUP BY currency
    HAVING COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'),  0)
        <> COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'transaction % is unbalanced in %: debits % <> credits %',
            NEW.transaction_id, bad.currency, bad.debits, bad.credits
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_transaction_must_balance
    AFTER INSERT ON entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION entries_check_transaction_balanced();

-- ───────────── Privileges for the API role ─────────────
-- Rule: the app inserts only the columns it needs. The database fills id,
-- created_at and the starting balance. The app reads new ids with RETURNING.
GRANT SELECT ON accounts, transactions, entries TO ledger_app;

GRANT INSERT (name, kind, currency)
    ON accounts TO ledger_app;
GRANT INSERT (kind, status, note, posted_at)
    ON transactions TO ledger_app;
GRANT INSERT (transaction_id, account_id, currency, direction, amount_paise)
    ON entries TO ledger_app;

GRANT UPDATE (balance_paise)     ON accounts     TO ledger_app;
GRANT UPDATE (status, posted_at) ON transactions TO ledger_app;

-- Deliberately absent: DELETE and TRUNCATE on anything, any UPDATE on entries.
