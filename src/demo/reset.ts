// Wipe and re-seed ONLY the web demo's clients (src/demo/seed.ts DEMO_CLIENTS),
// in one transaction, as ledger_owner. Nobody else's rows are touched: not the
// eval- clients, not load-test accounts, not system history (reconciliation runs,
// cooldowns).
//
// The ledger is append-only on purpose: entries, top-ups, webhook events and
// posted transactions refuse UPDATE and DELETE, even for the owner, through
// triggers. A demo reset is the one sanctioned exception, so it switches those
// triggers off for THIS transaction only (ALTER TABLE ... DISABLE TRIGGER is
// transactional: a rollback or a commit both leave them on again before anyone
// else can write), deletes the demo's rows, gives the bank settlement account
// back its side of every deleted entry, and seeds the demo again.
import type pg from 'pg';
import { DEMO_CLIENTS, seedDemo } from './seed.js';

const GUARDED_TABLES = ['entries', 'topups', 'webhook_events', 'idempotency_keys', 'transactions', 'outbox', 'agent_runs'] as const;

export interface ResetSummary {
  database: string;
  accounts: number;
  transactions: number;
  seeded: string[];
}

export async function resetDemo(client: pg.ClientBase): Promise<ResetSummary> {
  const clients = [...DEMO_CLIENTS];
  await client.query('BEGIN');
  try {
    // Waiting for the running demo's short transactions is fine; waiting forever is not.
    await client.query(`SET LOCAL lock_timeout = '15s'`);
    const db = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;

    await client.query(`CREATE TEMP TABLE demo_accounts ON COMMIT DROP AS SELECT id FROM accounts WHERE owner_client_id = ANY($1)`, [clients]);
    await client.query(
      `CREATE TEMP TABLE demo_tx ON COMMIT DROP AS
         SELECT transaction_id AS id FROM entries WHERE account_id IN (SELECT id FROM demo_accounts)
         UNION
         SELECT transaction_id FROM topups WHERE account_id IN (SELECT id FROM demo_accounts)`,
    );

    // A demo transaction may touch demo accounts and system accounts (bank
    // settlement), nothing else: deleting it would rewrite someone else's history.
    const foreign = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.transaction_id IN (SELECT id FROM demo_tx)
          AND a.kind = 'user' AND a.id NOT IN (SELECT id FROM demo_accounts)`,
    );
    if (foreign.rows[0]!.n > 0) throw new Error(`${foreign.rows[0]!.n} demo entries touch non-demo user accounts; refusing to delete them`);

    for (const t of GUARDED_TABLES) await client.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);

    // The system side of every deleted entry goes back: a debit had lowered the
    // bank's cached balance, a credit had raised it.
    await client.query(
      `UPDATE accounts a SET balance_paise = a.balance_paise + d.delta
         FROM (SELECT account_id, sum(CASE direction WHEN 'debit' THEN amount_paise ELSE -amount_paise END) AS delta
                 FROM entries
                WHERE transaction_id IN (SELECT id FROM demo_tx) AND account_id NOT IN (SELECT id FROM demo_accounts)
                GROUP BY account_id) d
        WHERE a.id = d.account_id`,
    );
    await client.query(`DELETE FROM webhook_events WHERE topup_transaction_id IN (SELECT id FROM demo_tx)`);
    await client.query(
      `DELETE FROM outbox
        WHERE payload->>'topupId' IN (SELECT id::text FROM demo_tx)
           OR payload->>'transactionId' IN (SELECT id::text FROM demo_tx)`,
    );
    await client.query(`DELETE FROM idempotency_keys WHERE client_id = ANY($1) OR transaction_id IN (SELECT id FROM demo_tx)`, [clients]);
    await client.query(`DELETE FROM agent_runs WHERE client_id = ANY($1)`, [clients]);
    await client.query(`DELETE FROM topups WHERE transaction_id IN (SELECT id FROM demo_tx)`);
    await client.query(`DELETE FROM entries WHERE transaction_id IN (SELECT id FROM demo_tx)`);
    const tx = await client.query(`DELETE FROM transactions WHERE id IN (SELECT id FROM demo_tx)`);
    const acc = await client.query(`DELETE FROM accounts WHERE id IN (SELECT id FROM demo_accounts)`);

    for (const t of GUARDED_TABLES) await client.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);

    const seeded = await seedDemo(client);
    if (!seeded) throw new Error('the demo still existed after the delete');
    await client.query('COMMIT');
    return { database: db, accounts: acc.rowCount ?? 0, transactions: tx.rowCount ?? 0, seeded };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
