-- migrations/004_topups_and_webhooks.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.
--
-- Money coming IN: a top-up is a 'topup' transaction that stays 'pending' (no
-- entries) until the payment provider confirms it by webhook. Then, in one
-- database transaction, the entries are written and the transaction is posted.

-- ───────────── Exactly one bank_settlement account per currency ─────────────
-- Top-ups debit the system account 'bank_settlement' in the top-up's currency.
-- This index guarantees there is at most one such account per currency, so a
-- race (or a careless script) can never split settlement across two rows.
CREATE UNIQUE INDEX accounts_one_bank_settlement_per_currency
    ON accounts (currency)
    WHERE kind = 'system' AND name = 'bank_settlement';

-- Seed the INR settlement account. A top-up in a currency that has no
-- settlement account is refused at creation time (422), never at posting time.
INSERT INTO accounts (name, kind, currency)
VALUES ('bank_settlement', 'system', 'INR')
ON CONFLICT (currency) WHERE kind = 'system' AND name = 'bank_settlement' DO NOTHING;

-- ───────────── topups ─────────────
-- Links a 'topup' transaction to the provider's payment and records what we
-- expect the provider to confirm (account, currency, amount).
CREATE TABLE topups (
    transaction_id      UUID        PRIMARY KEY REFERENCES transactions (id),
    account_id          UUID        NOT NULL,
    currency            CHAR(3)     NOT NULL,
    amount_paise        BIGINT      NOT NULL,
    provider_payment_id TEXT        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT topups_amount_positive
        CHECK (amount_paise > 0),
    -- the target account must exist and the top-up currency must be its currency
    CONSTRAINT topups_account_currency_fkey
        FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency),
    -- one payment can only ever confirm one top-up
    CONSTRAINT topups_provider_payment_id_key
        UNIQUE (provider_payment_id),
    CONSTRAINT topups_provider_payment_id_length
        CHECK (length(provider_payment_id) BETWEEN 1 AND 255)
);

-- A topups row may only point at a transaction that IS a top-up and is still
-- pending (it is written at the start, before the provider confirms anything).
-- FOR SHARE: needs UPDATE on some column of transactions; ledger_app has UPDATE (status).
CREATE FUNCTION topups_require_pending_topup_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    tx RECORD;
BEGIN
    SELECT kind, status INTO tx FROM transactions WHERE id = NEW.transaction_id FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW;  -- the foreign key reports the missing transaction
    END IF;
    IF tx.kind <> 'topup' THEN
        RAISE EXCEPTION 'topup % must point at a transaction of kind topup, not %', NEW.transaction_id, tx.kind;
    END IF;
    IF tx.status <> 'pending' THEN
        RAISE EXCEPTION 'topup % must be recorded while its transaction is pending, not %', NEW.transaction_id, tx.status;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER topups_only_for_pending_topup
    BEFORE INSERT ON topups
    FOR EACH ROW EXECUTE FUNCTION topups_require_pending_topup_transaction();

-- A top-up's expectation never changes after it is recorded (append-only, like entries).
CREATE FUNCTION topups_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'topups are append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER topups_no_update_or_delete
    BEFORE UPDATE OR DELETE ON topups
    FOR EACH ROW EXECUTE FUNCTION topups_block_changes();

-- ───────────── webhook_events ─────────────
-- Every webhook that passed signature verification, exactly once, with the raw
-- bytes we verified and what we did about it. Never changed, never deleted.
CREATE TABLE webhook_events (
    provider_event_id   TEXT        PRIMARY KEY,
    event_type          TEXT        NOT NULL,
    provider_payment_id TEXT        NOT NULL,
    raw_body            TEXT        NOT NULL,
    result              TEXT        NOT NULL,
    result_detail       TEXT,
    -- the top-up this event was matched to, if any
    topup_transaction_id UUID       REFERENCES transactions (id),
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT webhook_events_event_id_length
        CHECK (length(provider_event_id) BETWEEN 1 AND 255),
    CONSTRAINT webhook_events_event_type_length
        CHECK (length(event_type) BETWEEN 1 AND 100),
    CONSTRAINT webhook_events_result_valid
        CHECK (result IN (
            'posted',                   -- payment.succeeded applied: entries written, top-up posted
            'failed',                   -- payment.failed applied: top-up marked failed
            'ignored_already_final',    -- top-up was already posted/failed (late, out of order)
            'ignored_unknown_type',     -- genuine (signed) event of a type we do not handle
            'anomaly_amount_mismatch',  -- amount/currency differ from the pending top-up; NOT posted
            'unmatched'                 -- no top-up with this paymentId; kept for investigation
        )),
    -- a result that changed the ledger must say which top-up it changed
    CONSTRAINT webhook_events_applied_results_have_topup
        CHECK (result NOT IN ('posted', 'failed') OR topup_transaction_id IS NOT NULL)
);

CREATE INDEX webhook_events_provider_payment_id_idx ON webhook_events (provider_payment_id);
-- The investigation queue: anomalies and unmatched events, oldest first.
CREATE INDEX webhook_events_unresolved_idx ON webhook_events (received_at)
    WHERE result IN ('anomaly_amount_mismatch', 'unmatched');

CREATE FUNCTION webhook_events_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'webhook_events are append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER webhook_events_no_update_or_delete
    BEFORE UPDATE OR DELETE ON webhook_events
    FOR EACH ROW EXECUTE FUNCTION webhook_events_block_changes();

-- ───────────── Privileges for the API role ─────────────
GRANT SELECT ON topups, webhook_events TO ledger_app;
GRANT INSERT (transaction_id, account_id, currency, amount_paise, provider_payment_id)
    ON topups TO ledger_app;
GRANT INSERT (provider_event_id, event_type, provider_payment_id, raw_body, result, result_detail, topup_transaction_id)
    ON webhook_events TO ledger_app;
-- No UPDATE, no DELETE on either table, for anyone (the triggers block the owner too).
-- created_at / received_at are filled by the database.
