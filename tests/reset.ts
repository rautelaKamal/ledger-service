/**
 * Empty all ledger tables. Only ledger_owner may TRUNCATE, and TRUNCATE does
 * not fire the row-level "entries are append-only" trigger.
 * (Kept in its own file because global-setup.ts must not import `vitest`.)
 */
export async function resetLedger(owner: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await owner.query('TRUNCATE reconciliation_runs, outbox, webhook_events, topups, idempotency_keys, entries, transactions, accounts');
  // Re-apply the seed from migration 004: top-ups need the INR settlement account.
  await owner.query(`INSERT INTO accounts (name, kind, currency) VALUES ('bank_settlement', 'system', 'INR')`);
}
