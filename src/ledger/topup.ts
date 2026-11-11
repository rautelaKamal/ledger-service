import type { Pool, PoolClient } from '../db.js';
import { lockAccounts } from './locks.js';

// Money coming in. Convention (same as transfers): a credit increases a
// balance, a debit decreases it. A confirmed top-up of X onto account A is
//   debit  bank_settlement by X   (the bank owes us less / we hold their money)
//   credit A by X
// so bank_settlement (a system account) goes negative over time. That's expected.

export const SETTLEMENT_ACCOUNT_NAME = 'bank_settlement';

/** The system account that top-ups in `currency` are debited from, if one exists. */
export async function findSettlementAccount(db: Pool | PoolClient, currency: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM accounts WHERE kind = 'system' AND name = $1 AND currency = $2`,
    [SETTLEMENT_ACCOUNT_NAME, currency],
  );
  return rows[0]?.id ?? null;
}

export interface PostTopupInput {
  transactionId: string;
  accountId: string;
  settlementAccountId: string;
  currency: string;
  amountPaise: bigint;
}

/**
 * Apply a CONFIRMED top-up inside the caller's transaction: write the two
 * entries, update both cached balances, flip the transaction to posted.
 * The caller has already checked that the transaction is pending and that the
 * amount/currency match what the provider confirmed.
 */
export async function postTopup(client: PoolClient, input: PostTopupInput): Promise<void> {
  // Same lock helper and therefore the same lock ORDER as transfers: a top-up
  // onto A and a transfer out of A queue behind each other instead of
  // deadlocking. bank_settlement is in every top-up's lock set, which makes
  // it a hot row (see STEP-04-EXPLAINED).
  const locked = await lockAccounts(client, [input.accountId, input.settlementAccountId]);
  if (!locked.has(input.accountId) || !locked.has(input.settlementAccountId)) {
    throw new Error(`top-up ${input.transactionId}: account or settlement account disappeared`);
  }

  await client.query(
    `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
     VALUES ($1, $2, $3, 'debit',  $4),
            ($1, $5, $3, 'credit', $4)`,
    [input.transactionId, input.settlementAccountId, input.currency, input.amountPaise, input.accountId],
  );
  await client.query(`UPDATE accounts SET balance_paise = balance_paise - $2 WHERE id = $1`, [
    input.settlementAccountId,
    input.amountPaise,
  ]);
  await client.query(`UPDATE accounts SET balance_paise = balance_paise + $2 WHERE id = $1`, [
    input.accountId,
    input.amountPaise,
  ]);
  // The database stamps posted_at; the deferred triggers check balance and
  // "entries only on posted transactions" at COMMIT.
  await client.query(`UPDATE transactions SET status = 'posted' WHERE id = $1`, [input.transactionId]);
}

/** Mark a pending top-up as failed (it has no entries, so rule 4 allows it). */
export async function failTopup(client: PoolClient, transactionId: string): Promise<void> {
  await client.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [transactionId]);
}
