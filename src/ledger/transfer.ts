import type { Pool, PoolClient } from '../db.js';
import { enqueueOutbox } from '../outbox/enqueue.js';
import { lockAccounts } from './locks.js';

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountPaise: bigint;
  note?: string;
}

export interface TransferResult {
  transactionId: string;
}

export class InvalidAmountError extends Error {
  override name = 'InvalidAmountError';
}

export class SameAccountError extends Error {
  override name = 'SameAccountError';
}

export class CurrencyMismatchError extends Error {
  override name = 'CurrencyMismatchError';
}

export class AccountNotFoundError extends Error {
  override name = 'AccountNotFoundError';
}

export class InsufficientFundsError extends Error {
  override name = 'InsufficientFundsError';
}

/**
 * Move `amountPaise` from one account to another, inside a transaction YOU own.
 *
 * Use this when the transfer must commit together with other writes (for
 * example the idempotency key that records it). `client` must already be
 * inside BEGIN; this function never COMMITs or ROLLBACKs. On any throw, the
 * caller must ROLLBACK (or ROLLBACK TO a savepoint).
 *
 * Convention: a debit decreases a balance, a credit increases it.
 * A transfer of X from A to B = debit A by X, credit B by X.
 *
 * Default isolation (READ COMMITTED) is safe here because the only read the
 * decisions depend on is the `FOR UPDATE` select in step 2, and a `FOR UPDATE`
 * read always returns the latest committed value of a row and keeps it locked
 * until the surrounding transaction ends.
 */
export async function transferWithClient(client: PoolClient, input: TransferInput): Promise<TransferResult> {
  // Step 0: validate the input before touching the database.
  // Prevents: writing anything at all for a request that can never be valid.
  if (input.amountPaise <= 0n) {
    throw new InvalidAmountError(`amount must be greater than 0 paise, got ${input.amountPaise}`);
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new SameAccountError(`cannot transfer from account ${input.fromAccountId} to itself`);
  }

  // Step 2: lock both account rows, always in ascending id order.
  // `FOR UPDATE` makes this read wait for any other operation that has these
  // rows locked, then returns the committed balances and keeps the rows
  // locked until our COMMIT. Nobody else can read-for-update or change them
  // in between.
  // Prevents: two transfers both reading "₹50 available" at the same moment
  // and both spending it (the lost update in test 4).
  // The ORDER BY id inside lockAccounts means every operation (transfers in
  // either direction, top-ups) takes the lock on the lower id first, so two
  // operations on the same accounts queue one behind the other instead of
  // each holding one row and waiting for the other's row forever.
  // Prevents: the deadlock in test 5 (A->B holds A and wants B, while B->A
  // holds B and wants A), and the same between a transfer and a top-up.
  const locked = await lockAccounts(client, [input.fromAccountId, input.toAccountId]);

  // Step 3: both accounts must exist and share one currency.
  // Prevents: moving money into a typo'd or deleted account, and turning
  // 100 USD into 100 INR by crediting the wrong currency.
  const from = locked.get(input.fromAccountId);
  const to = locked.get(input.toAccountId);
  if (!from) {
    throw new AccountNotFoundError(`account ${input.fromAccountId} does not exist`);
  }
  if (!to) {
    throw new AccountNotFoundError(`account ${input.toAccountId} does not exist`);
  }
  if (from.currency !== to.currency) {
    throw new CurrencyMismatchError(
      `cannot transfer between ${from.currency} account ${from.id} and ${to.currency} account ${to.id}`,
    );
  }

  // Step 4: the sender must be able to afford it.
  // The balance we compare against is the one we locked in step 2, so no
  // other transfer can lower it before we COMMIT.
  // Prevents: spending money that was already spent by a concurrent transfer.
  if (from.balance_paise < input.amountPaise) {
    throw new InsufficientFundsError(
      `account ${from.id} has ${from.balance_paise} paise, cannot transfer ${input.amountPaise}`,
    );
  }

  // Step 5: create the transaction. It starts as 'pending' (the column
  // default; the app is not even allowed to set status on insert).
  // Prevents: a transaction being visible as 'posted' before its entries exist.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO transactions (kind, note)
     VALUES ('transfer', $1)
     RETURNING id`,
    [input.note ?? null],
  );
  const transactionId = inserted.rows[0]!.id;

  // Step 6: write the two khata lines: debit the sender, credit the receiver.
  // The currency comes from the locked account rows, so it always matches
  // what the composite foreign key expects.
  // Prevents: a one-sided movement of money. The deferred trigger will check
  // at COMMIT that these two amounts balance.
  await client.query(
    `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
     VALUES ($1, $2, $3, 'debit',  $4),
            ($1, $5, $3, 'credit', $4)`,
    [transactionId, from.id, from.currency, input.amountPaise, to.id],
  );

  // Step 7: update the cached balances, relative to the current value.
  // We hold the locks, so these cannot race; writing "balance - amount"
  // instead of a precomputed number keeps the SQL honest about what it does,
  // and the CHECK on user accounts stays as a last line of defence.
  // Prevents: a stale balance being written over a newer one.
  await client.query(`UPDATE accounts SET balance_paise = balance_paise - $2 WHERE id = $1`, [
    from.id,
    input.amountPaise,
  ]);
  await client.query(`UPDATE accounts SET balance_paise = balance_paise + $2 WHERE id = $1`, [
    to.id,
    input.amountPaise,
  ]);

  // Step 8: post the transaction. The database stamps posted_at and checks
  // that there are at least 2 entries.
  // Prevents: entries existing for a transaction that is not posted (the
  // deferred rule 6 would reject the COMMIT otherwise).
  await client.query(`UPDATE transactions SET status = 'posted' WHERE id = $1`, [transactionId]);

  // Step 8b: queue the 'transfer.posted' event for the outbox worker, in THIS
  // transaction. If the COMMIT below fails, the event vanishes with the transfer;
  // if it succeeds, the event is guaranteed to exist. Nobody is notified from here.
  // Prevents: "money moved but nobody was told" and "told, but money never moved".
  await enqueueOutbox(client, 'transfer.posted', {
    transactionId,
    fromAccountId: from.id,
    toAccountId: to.id,
    currency: from.currency,
    amountPaise: input.amountPaise.toString(),
  });

  return { transactionId };
}

/**
 * Move `amountPaise` from one account to another, in its own database transaction.
 *
 * Borrows ONE client from the pool, runs transferWithClient() on it between
 * BEGIN and COMMIT, and always gives the client back clean.
 */
export async function transfer(pool: Pool, input: TransferInput): Promise<TransferResult> {
  // Step 1: borrow ONE client and open a transaction on it.
  // Prevents: statements landing on different connections. A row lock belongs
  // to the connection that took it; if the inserts ran on another connection
  // they would not be protected by it (and `pool.query` picks any connection).
  const client = await pool.connect();
  // Set to true only if ROLLBACK itself fails, meaning the connection is broken.
  let connectionBroken = false;
  try {
    await client.query('BEGIN');

    // Steps 0 and 2-8: validate, lock, check, write (see transferWithClient).
    const result = await transferWithClient(client, input);

    // Step 9: COMMIT. This is where the deferred triggers run:
    // debits = credits per currency, and every touched transaction is posted.
    // Only after this line is any of the above visible to anyone else, and the
    // row locks from step 2 are released.
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Any failure above: undo everything this transaction did.
    // Prevents: a half-written transfer (e.g. entries without balance changes).
    try {
      await client.query('ROLLBACK');
    } catch {
      // ROLLBACK can only fail if the connection itself is dead.
      connectionBroken = true;
    }
    throw err;
  } finally {
    // Always give the client back. After COMMIT or ROLLBACK the connection is
    // outside any transaction, so the next borrower starts clean.
    // Prevents: the next caller inheriting an aborted transaction (every
    // query on it would fail with "current transaction is aborted").
    // `release(true)` tells the pool to destroy a broken connection instead
    // of handing it out again.
    client.release(connectionBroken ? true : undefined);
  }
}
