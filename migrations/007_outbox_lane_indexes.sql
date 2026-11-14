-- migrations/007_outbox_lane_indexes.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.
--
-- The outbox has two LANES (see src/worker/lanes.ts):
--   commands  type LIKE 'provider.%'   a user is waiting (e.g. a top-up needs a payment)
--   events    everything else          notifications; bulk, can lag a little
-- Each lane claims its next row from its own small index, so a commands
-- worker never walks past thousands of pending events to find its row.
-- The WHERE clauses are written exactly like the claim queries' predicates,
-- so Postgres can prove each index applies.
--
-- (In production, build these with CREATE INDEX CONCURRENTLY, which cannot
-- run inside a transaction; our runner wraps every file in one. The outbox is
-- small here, so the brief lock of a plain CREATE INDEX is harmless.)
CREATE INDEX outbox_pending_commands_idx ON outbox (available_at, id)
    WHERE status = 'pending' AND type LIKE 'provider.%';

CREATE INDEX outbox_pending_events_idx ON outbox (available_at, id)
    WHERE status = 'pending' AND type NOT LIKE 'provider.%';
