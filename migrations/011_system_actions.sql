-- Step 7d: the "under the hood" page can START two things on demand:
--   reconcile  run every reconciliation check now and record the run
--   chaos      the demo's 200-concurrent-transfers test
--
-- A public demo must not let anyone run them in a loop, so each action has a
-- COOLDOWN (one start per N seconds, default 60). It is enforced HERE, in the
-- database, not in a process's memory: with two API replicas (and two web
-- replicas) an in-memory timer would allow one run per replica. A start is a
-- row; whoever wants to start one takes an advisory lock for that action,
-- looks at the newest row and inserts only if it is old enough.
--
-- Numbered 011: step 7c (branch step-7c-eval) adds 010. The two are independent.

CREATE TABLE system_actions (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action      TEXT        NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT system_actions_action_valid
        CHECK (action IN ('reconcile', 'chaos'))
);

CREATE INDEX system_actions_action_started_idx ON system_actions (action, started_at DESC);

-- The API serves these actions on its INTERNAL port, through a pool that logs
-- in as ledger_reconciler (read-only on the ledger, append-only on its own
-- records). It may record a start and read the history; nobody may change or
-- delete a row (no UPDATE/DELETE grant for anyone but the owner).
GRANT SELECT ON system_actions TO ledger_reconciler;
GRANT INSERT (action) ON system_actions TO ledger_reconciler;
