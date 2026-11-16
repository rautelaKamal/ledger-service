-- migrations/008_account_ownership_and_agent_access.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.
--
-- Part A: every user account belongs to exactly one client (the X-Client-Id
--         that may spend from it and top it up).
-- Part B: a read-only role for the AI assistant, ledger_agent, that reads
--         through views and whose every query is filtered by row-level
--         security to the client named in app.client_id.

-- ───────────── Guard: the agent role must exist ─────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_agent') THEN
        RAISE EXCEPTION 'role ledger_agent must exist: run k8s/base/postgres/init/00-roles.sql first (npm run db:roles)';
    END IF;
END;
$$;

-- ═════════════ Part A: account ownership ═════════════
ALTER TABLE accounts ADD COLUMN owner_client_id TEXT;

-- A user account has exactly one owner; a system account has none.
-- NOT VALID: rows that exist before this migration are exempt (they keep a
-- NULL owner, and a NULL owner matches no caller, so nobody can spend from
-- them through the API until an owner is assigned). Every new or updated row
-- must satisfy it.
ALTER TABLE accounts ADD CONSTRAINT accounts_user_has_owner
    CHECK ((kind = 'system') = (owner_client_id IS NULL)) NOT VALID;
ALTER TABLE accounts ADD CONSTRAINT accounts_owner_client_id_length
    CHECK (owner_client_id IS NULL OR length(owner_client_id) BETWEEN 1 AND 255);

-- "the accounts of client X": the API's ownership check and every agent query.
CREATE INDEX accounts_owner_client_id_idx ON accounts (owner_client_id)
    WHERE owner_client_id IS NOT NULL;
-- "top-ups onto account X": the other half of agent_transaction_ids() below.
-- (entries already has entries_account_id_idx and entries_transaction_id_idx.)
CREATE INDEX topups_account_id_idx ON topups (account_id);

-- An owner is chosen when the account is created and never changes. The one
-- permitted update is NULL -> a value, for rows that predate this migration.
CREATE FUNCTION accounts_owner_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.owner_client_id IS NOT NULL
       AND NEW.owner_client_id IS DISTINCT FROM OLD.owner_client_id THEN
        RAISE EXCEPTION 'account %: owner_client_id cannot change (% -> %)',
            OLD.id, OLD.owner_client_id, NEW.owner_client_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_owner_immutable
    BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION accounts_owner_is_immutable();

-- The API sets the owner when it creates an account; it still cannot UPDATE it.
GRANT INSERT (owner_client_id) ON accounts TO ledger_app;

-- ═════════════ Part B: what the assistant may read ═════════════
GRANT USAGE ON SCHEMA public TO ledger_agent;
-- /readyz for the agent: "are all migration files applied?"
GRANT SELECT (filename) ON schema_migrations TO ledger_agent;

-- ───────────── Row-level security ─────────────
-- Once enabled on a table, that table shows a role NOTHING unless a policy
-- grants rows. The table owner (ledger_owner: migrations, tests, seeds) is not
-- subject to it. The service roles therefore get an explicit "all rows" policy
-- first: what they may DO is still governed by their GRANTs (column lists, no
-- DELETE); these policies take nothing away and add nothing.
ALTER TABLE accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE topups       ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_roles_all_rows ON accounts
    FOR ALL TO ledger_app, ledger_worker, ledger_reconciler USING (true) WITH CHECK (true);
CREATE POLICY service_roles_all_rows ON transactions
    FOR ALL TO ledger_app, ledger_worker, ledger_reconciler USING (true) WITH CHECK (true);
CREATE POLICY service_roles_all_rows ON entries
    FOR ALL TO ledger_app, ledger_worker, ledger_reconciler USING (true) WITH CHECK (true);
CREATE POLICY service_roles_all_rows ON topups
    FOR ALL TO ledger_app, ledger_worker, ledger_reconciler USING (true) WITH CHECK (true);

-- The client the assistant is acting for. The agent sets it per request, inside
-- the transaction that runs the request's queries, with a BIND PARAMETER:
--     BEGIN READ ONLY;
--     SELECT set_config('app.client_id', $1, true);   -- true = LOCAL to this transaction
--     SELECT ...;
--     COMMIT;
-- The value is plain data to Postgres, whatever characters it holds. A LOCAL
-- setting dies with the transaction, so a pooled connection never carries a
-- client id into the next request. Unset or empty means NULL, and NULL equals
-- no owner: the assistant sees nothing at all.
CREATE FUNCTION agent_client_id() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.client_id', true), '')
$$;

-- "Transactions this client took part in": any leg on one of their accounts,
-- or a top-up onto one. SECURITY DEFINER: it runs as ledger_owner, who is not
-- subject to the policies, so the policy ON entries can ask a question ABOUT
-- entries without recursing into itself. It returns ids only, and only for
-- the client in app.client_id.
CREATE FUNCTION agent_transaction_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT e.transaction_id
      FROM entries e JOIN accounts a ON a.id = e.account_id
     WHERE a.owner_client_id = agent_client_id()
    UNION
    SELECT t.transaction_id
      FROM topups t JOIN accounts a ON a.id = t.account_id
     WHERE a.owner_client_id = agent_client_id()
$$;
REVOKE ALL ON FUNCTION agent_transaction_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_transaction_ids() TO ledger_agent;

-- The agent's policies: SELECT only (there is no INSERT/UPDATE/DELETE policy,
-- and no such GRANT either).
CREATE POLICY agent_own_accounts ON accounts
    FOR SELECT TO ledger_agent USING (owner_client_id = agent_client_id());
CREATE POLICY agent_own_transactions ON transactions
    FOR SELECT TO ledger_agent USING (id IN (SELECT agent_transaction_ids()));
CREATE POLICY agent_own_entries ON entries
    FOR SELECT TO ledger_agent USING (transaction_id IN (SELECT agent_transaction_ids()));
CREATE POLICY agent_own_topups ON topups
    FOR SELECT TO ledger_agent USING (transaction_id IN (SELECT agent_transaction_ids()));

-- ───────────── Views: the contract ─────────────
-- Exactly the columns the assistant needs. Nothing from idempotency_keys
-- (stored responses), webhook_events (raw bodies), outbox or reconciliation_runs,
-- and no provider payment ids.
-- security_invoker: the view runs as the CALLER (ledger_agent), so the
-- policies above apply inside it. Without it a view runs as its owner, and
-- ledger_owner is not subject to RLS.
CREATE VIEW agent_accounts WITH (security_invoker = true) AS
    SELECT id, name, currency, balance_paise, created_at
      FROM accounts
     WHERE kind = 'user';

CREATE VIEW agent_transactions WITH (security_invoker = true) AS
    SELECT id, kind, status, note, created_at, posted_at
      FROM transactions;

-- Every leg of a transaction the client took part in. own_account is true for
-- the client's own legs: the LEFT JOIN finds the account only if the accounts
-- policy lets this client see it.
CREATE VIEW agent_entries WITH (security_invoker = true) AS
    SELECT e.id, e.transaction_id, e.account_id, e.currency, e.direction, e.amount_paise, e.created_at,
           (a.id IS NOT NULL) AS own_account
      FROM entries e
      LEFT JOIN accounts a ON a.id = e.account_id;

CREATE VIEW agent_topups WITH (security_invoker = true) AS
    SELECT t.transaction_id, t.account_id, t.currency, t.amount_paise, t.created_at,
           x.status, x.posted_at
      FROM topups t
      JOIN transactions x ON x.id = t.transaction_id;

GRANT SELECT ON agent_accounts, agent_transactions, agent_entries, agent_topups TO ledger_agent;

-- security_invoker means the caller also needs SELECT on the base tables.
-- Column lists keep a hand-written query on them to the same data the views
-- show (SELECT * fails; owner_client_id and provider_payment_id are never readable).
GRANT SELECT (id, name, kind, currency, balance_paise, created_at)                            ON accounts     TO ledger_agent;
GRANT SELECT (id, kind, status, note, created_at, posted_at)                                  ON transactions TO ledger_agent;
GRANT SELECT (id, transaction_id, account_id, currency, direction, amount_paise, created_at)  ON entries      TO ledger_agent;
GRANT SELECT (transaction_id, account_id, currency, amount_paise, created_at)                 ON topups       TO ledger_agent;

-- Deliberately absent for ledger_agent: INSERT, UPDATE, DELETE anywhere; any
-- access to idempotency_keys, webhook_events, outbox, reconciliation_runs.
