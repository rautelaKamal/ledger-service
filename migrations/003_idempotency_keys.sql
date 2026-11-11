-- migrations/003_idempotency_keys.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.
--
-- One row per (client, Idempotency-Key). The row is inserted at the START of the
-- request, in the same database transaction as the transfer, and updated with
-- the response at the END. It becomes visible to other sessions only at COMMIT,
-- complete with its response. A second request with the same key blocks on the
-- primary key until the first commits or rolls back, then replays or proceeds.

CREATE TABLE idempotency_keys (
    client_id       TEXT        NOT NULL,
    key             TEXT        NOT NULL,
    -- sha256 (hex) of method + path + canonical body; detects key reuse
    request_hash    TEXT        NOT NULL,
    -- NULL only inside the transaction that is still processing the request;
    -- never NULL in a committed row (the response is written before COMMIT)
    response_status INTEGER,
    response_body   JSONB,
    -- the transfer this key produced, if it succeeded (audit / debugging)
    transaction_id  UUID        REFERENCES transactions (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- set by the database; the app cannot choose how long a key lives
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',

    -- keys are scoped per client: the same key from two clients is two requests
    CONSTRAINT idempotency_keys_pkey
        PRIMARY KEY (client_id, key),
    CONSTRAINT idempotency_keys_client_id_length
        CHECK (length(client_id) BETWEEN 1 AND 255),
    CONSTRAINT idempotency_keys_key_length
        CHECK (length(key) BETWEEN 1 AND 255),
    CONSTRAINT idempotency_keys_request_hash_format
        CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT idempotency_keys_status_range
        CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599),
    -- status and body are stored together or not at all
    CONSTRAINT idempotency_keys_response_complete
        CHECK ((response_status IS NULL) = (response_body IS NULL)),
    CONSTRAINT idempotency_keys_expires_after_created
        CHECK (expires_at > created_at)
);

-- The cleanup job deletes by expiry time.
CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

-- ───────────── Trigger: a stored response is frozen ─────────────
-- Prevents a bug from overwriting what a client was already told. Also keeps
-- identity and timing columns immutable in all cases.
CREATE FUNCTION idempotency_keys_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.client_id    IS DISTINCT FROM OLD.client_id
    OR NEW.key          IS DISTINCT FROM OLD.key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.created_at   IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at   IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'idempotency key (%, %): client_id, key, request_hash, created_at and expires_at are immutable',
            OLD.client_id, OLD.key;
    END IF;

    IF OLD.response_status IS NOT NULL THEN
        RAISE EXCEPTION 'idempotency key (%, %) already has a stored response and can no longer be changed',
            OLD.client_id, OLD.key;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_keys_frozen_once_stored
    BEFORE UPDATE ON idempotency_keys
    FOR EACH ROW EXECUTE FUNCTION idempotency_keys_block_changes();

-- ───────────── Trigger: only expired keys may be deleted ─────────────
-- Deleting a live key is the one way this table could cause a duplicate
-- transfer (the retry would be treated as new). Rows may be deleted, because
-- they are not ledger entries and cleanup needs it, but only once expired.
CREATE FUNCTION idempotency_keys_block_live_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.expires_at > now() THEN
        RAISE EXCEPTION 'idempotency key (%, %) has not expired (expires at %) and cannot be deleted',
            OLD.client_id, OLD.key, OLD.expires_at;
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER idempotency_keys_delete_only_expired
    BEFORE DELETE ON idempotency_keys
    FOR EACH ROW EXECUTE FUNCTION idempotency_keys_block_live_delete();

-- ───────────── Privileges for the API role ─────────────
-- Same rule as before: the app writes only the columns it must; the database
-- fills created_at and expires_at.
GRANT SELECT ON idempotency_keys TO ledger_app;
GRANT INSERT (client_id, key, request_hash) ON idempotency_keys TO ledger_app;
GRANT UPDATE (response_status, response_body, transaction_id) ON idempotency_keys TO ledger_app;
-- Cleanup (and reclaiming an expired key) needs DELETE; the trigger above
-- limits it to expired rows.
GRANT DELETE ON idempotency_keys TO ledger_app;
