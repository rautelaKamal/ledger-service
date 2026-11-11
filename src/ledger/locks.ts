import type { PoolClient } from '../db.js';

/** An account row as returned by lockAccounts(). */
export interface LockedAccount {
  id: string;
  kind: 'user' | 'system';
  currency: string;
  balance_paise: bigint;
}

/**
 * Lock account rows with `SELECT … FOR UPDATE`, always in ascending id order.
 *
 * Every piece of code that moves money (transfers, top-ups, later refunds)
 * MUST take its account locks through this one function. Because all of them
 * lock in the same global order (by id), two operations that touch the same
 * accounts queue up behind each other instead of each holding one row and
 * waiting for the other's: that is what makes deadlocks impossible between
 * them, no matter which direction the money flows.
 *
 * `FOR UPDATE` also makes this read return the latest COMMITTED balance and
 * keeps the rows locked until the surrounding transaction ends, so a balance
 * check done on the result stays true until COMMIT.
 *
 * Returns the rows found, keyed by id. Missing ids are simply absent.
 */
export async function lockAccounts(client: PoolClient, ids: readonly string[]): Promise<Map<string, LockedAccount>> {
  const { rows } = await client.query<LockedAccount>(
    `SELECT id, kind, currency, balance_paise
       FROM accounts
      WHERE id = ANY($1::uuid[])
      ORDER BY id
        FOR UPDATE`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}
