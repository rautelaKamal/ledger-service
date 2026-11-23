-- migrations/010_agent_policy_performance.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.
--
-- Step 7c: the assistant's row-level security, made cheap. Same rows, same
-- rules; only how Postgres evaluates them changes. Measured with
-- list_transactions on the 100k-transaction dev ledger (one client, 3 rows):
--
--                                   before        after
--   first call after a cold start   36.9 s, 7.5 s  142 ms, 203 ms
--   warm, median                    74-117 ms      9-11 ms
--
-- 1. `id IN (SELECT agent_transaction_ids())` became a hashed subplan that can
--    only FILTER rows: every agent query read the whole transactions table
--    (100k rows; seconds when it is not cached). `= ANY (ARRAY(...))` computes
--    the set once per query (an InitPlan) and lets Postgres LOOK UP those ids
--    through transactions_pkey and entries_transaction_id_idx instead.
-- 2. agent_transaction_ids() was LANGUAGE sql. A SECURITY DEFINER sql function
--    cannot be inlined, and Postgres 17 re-plans its body on every call
--    (30 ms here, 1 s cold, to return 3 ids). PL/pgSQL keeps the plan for the
--    life of the connection, and the agent reuses pooled connections.

CREATE OR REPLACE FUNCTION agent_transaction_ids() RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    RETURN QUERY
        SELECT e.transaction_id
          FROM entries e JOIN accounts a ON a.id = e.account_id
         WHERE a.owner_client_id = agent_client_id()
        UNION
        SELECT t.transaction_id
          FROM topups t JOIN accounts a ON a.id = t.account_id
         WHERE a.owner_client_id = agent_client_id();
END;
$$;
-- (CREATE OR REPLACE keeps the grants: EXECUTE for ledger_agent only.)

ALTER POLICY agent_own_transactions ON transactions
    USING (id = ANY (ARRAY(SELECT agent_transaction_ids())));
ALTER POLICY agent_own_entries ON entries
    USING (transaction_id = ANY (ARRAY(SELECT agent_transaction_ids())));
ALTER POLICY agent_own_topups ON topups
    USING (transaction_id = ANY (ARRAY(SELECT agent_transaction_ids())));
