import { expect } from 'vitest';
import type { Pool, PoolClient } from '../src/db.js';
import { findUnreconciledAccounts } from '../src/ledger/reconciliation.js';

// Postgres error codes (SQLSTATE) used in the tests.
export const PG = {
  INSUFFICIENT_PRIVILEGE: '42501', // missing GRANT
  CHECK_VIOLATION: '23514', // CHECK constraint, and our deferred COMMIT checks
  FOREIGN_KEY_VIOLATION: '23503',
  RAISE_EXCEPTION: 'P0001', // plain RAISE EXCEPTION in a trigger
  DEADLOCK_DETECTED: '40P01',
  UNIQUE_VIOLATION: '23505',
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

/** Run `fn` inside BEGIN ... COMMIT (ROLLBACK if it throws). */
export async function withCommit<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The X-Client-Id the tests act as, and therefore the owner of the user accounts they create. */
export const TEST_CLIENT = 'test-client';

/**
 * Since step 7a a user account belongs to exactly one client (owner_client_id);
 * a system account to nobody. `owner` is ignored for system accounts.
 */
export async function createAccount(
  db: Queryable,
  kind: 'user' | 'system',
  currency = 'INR',
  name = `test ${kind} account`,
  owner: string = TEST_CLIENT,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO accounts (name, kind, currency, owner_client_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, kind, currency, kind === 'user' ? owner : null],
  );
  return rows[0]!.id;
}

/** A new transaction always starts as 'pending' (the column default). */
export async function createTransaction(
  db: Queryable,
  kind: 'transfer' | 'topup' | 'refund' = 'transfer',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transactions (kind) VALUES ($1) RETURNING id`,
    [kind],
  );
  return rows[0]!.id;
}

export async function postTransaction(db: Queryable, transactionId: string): Promise<void> {
  await db.query(`UPDATE transactions SET status = 'posted' WHERE id = $1`, [transactionId]);
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
 * Commit a posted, balanced two-entry transaction (system account -> user account).
 * Only writes entries; does NOT touch cached balances (step 1 tests don't need them).
 */
export async function commitBalancedTransaction(
  pool: Pool,
  amountPaise: bigint,
): Promise<{ transactionId: string; debitEntryId: string }> {
  const from = await createAccount(pool, 'system');
  const to = await createAccount(pool, 'user');
  return withCommit(pool, async (db) => {
    const transactionId = await createTransaction(db);
    const debitEntryId = await insertEntry(db, { transactionId, accountId: from, direction: 'debit', amountPaise });
    await insertEntry(db, { transactionId, accountId: to, direction: 'credit', amountPaise });
    await postTransaction(db, transactionId);
    return { transactionId, debitEntryId };
  });
}

/**
 * Fund a user account the proper way: a balanced, posted 'topup' from the
 * system account 'bank_settlement' (created on first use, per currency).
 * Runs as ledger_owner. Convention: credit increases a balance, debit decreases it.
 */
/** `daysAgo` back-dates the transaction's created_at: only possible at insert (posted transactions are immutable). */
export async function fundAccount(owner: Pool, accountId: string, amountPaise: bigint, daysAgo = 0): Promise<void> {
  await withCommit(owner, async (db) => {
    const { rows } = await db.query<{ currency: string }>('SELECT currency FROM accounts WHERE id = $1', [accountId]);
    const currency = rows[0]!.currency;

    const existing = await db.query<{ id: string }>(
      `SELECT id FROM accounts WHERE name = 'bank_settlement' AND kind = 'system' AND currency = $1`,
      [currency],
    );
    const bankId = existing.rows[0]?.id ?? (await createAccount(db, 'system', currency, 'bank_settlement'));

    const transactionId =
      daysAgo === 0
        ? await createTransaction(db, 'topup')
        : (
            await db.query<{ id: string }>(
              `INSERT INTO transactions (kind, created_at) VALUES ('topup', now() - make_interval(days => $1)) RETURNING id`,
              [daysAgo],
            )
          ).rows[0]!.id;
    await insertEntry(db, { transactionId, accountId: bankId, currency, direction: 'debit', amountPaise });
    await insertEntry(db, { transactionId, accountId, currency, direction: 'credit', amountPaise });
    await db.query('UPDATE accounts SET balance_paise = balance_paise - $2 WHERE id = $1', [bankId, amountPaise]);
    await db.query('UPDATE accounts SET balance_paise = balance_paise + $2 WHERE id = $1', [accountId, amountPaise]);
    await postTransaction(db, transactionId);
  });
}

export async function balanceOf(db: Queryable, accountId: string): Promise<bigint> {
  const { rows } = await db.query<{ balance_paise: bigint }>('SELECT balance_paise FROM accounts WHERE id = $1', [
    accountId,
  ]);
  return rows[0]!.balance_paise;
}

/** Reusable assertion: every account's cached balance equals credits - debits of its posted entries. */
export async function expectLedgerReconciles(db: Queryable): Promise<void> {
  expect(await findUnreconciledAccounts(db)).toEqual([]);
}
