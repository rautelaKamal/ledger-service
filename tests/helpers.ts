import type { Pool, PoolClient } from '../src/db.js';

// Postgres error codes (SQLSTATE) used in the tests.
export const PG = {
  INSUFFICIENT_PRIVILEGE: '42501', // missing GRANT
  CHECK_VIOLATION: '23514', // CHECK constraint, and our balance trigger
  FOREIGN_KEY_VIOLATION: '23503',
  RAISE_EXCEPTION: 'P0001', // plain RAISE EXCEPTION in a trigger
} as const;

type Queryable = Pool | PoolClient;

/**
 * Run `fn` inside BEGIN ... ROLLBACK. Nothing it does is ever committed.
 * Used by tests that only need to see a statement being rejected.
 */
export async function withRollback<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

export async function createAccount(
  db: Queryable,
  kind: 'user' | 'system',
  currency = 'INR',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO accounts (name, kind, currency) VALUES ($1, $2, $3) RETURNING id`,
    [`test ${kind} account`, kind, currency],
  );
  return rows[0]!.id;
}

export async function createTransaction(db: Queryable, status: 'pending' | 'posted' = 'pending'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transactions (kind, status, posted_at)
     VALUES ('transfer', $1, CASE WHEN $1 = 'posted' THEN now() END)
     RETURNING id`,
    [status],
  );
  return rows[0]!.id;
}

export async function insertEntry(
  db: Queryable,
  e: { transactionId: string; accountId: string; currency?: string; direction: 'debit' | 'credit'; amountPaise: bigint },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [e.transactionId, e.accountId, e.currency ?? 'INR', e.direction, e.amountPaise],
  );
  return rows[0]!.id;
}

/**
 * Commit a balanced two-entry transaction (system account -> user account)
 * and return the id of its debit entry.
 */
export async function commitBalancedTransaction(pool: Pool, amountPaise: bigint): Promise<string> {
  const from = await createAccount(pool, 'system');
  const to = await createAccount(pool, 'user');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txId = await createTransaction(client);
    const debitId = await insertEntry(client, { transactionId: txId, accountId: from, direction: 'debit', amountPaise });
    await insertEntry(client, { transactionId: txId, accountId: to, direction: 'credit', amountPaise });
    await client.query('COMMIT');
    return debitId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
