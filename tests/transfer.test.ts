// Tests for transfer(). They are RED until transfer() is implemented.
//
// Convention: a credit increases an account's balance, a debit decreases it.
// A transfer of X from A to B = debit A by X, credit B by X.
//
// Setup:
//   * beforeAll TRUNCATEs the ledger (as owner) so "every account reconciles"
//     is checked over a clean ledger: step 1 tests deliberately leave accounts
//     whose cached balance doesn't match their entries. Safe because test files
//     run one after another (fileParallelism: false).
//   * Accounts are funded with fundAccount(): a real posted topup from the
//     'bank_settlement' system account, written as ledger_owner. Never by
//     editing balances directly.
//   * afterEach checks that the whole ledger reconciles.
//
// Pool size and timeouts (see docs/STEP-02-NOTES.md):
//   * app pool max 20: ~20 database transactions in flight at once, all
//     contending on the same one or two account rows.
//   * concurrency tests get 30 s.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import {
  AccountNotFoundError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  SameAccountError,
  transfer,
} from '../src/ledger/transfer.js';
import { PG, balanceOf, createAccount, expectLedgerReconciles, fundAccount } from './helpers.js';
import { resetLedger } from './reset.js';

const APP_POOL_SIZE = 20;
const CONCURRENCY_TEST_TIMEOUT_MS = 30_000;

let app: Pool; // connected as ledger_app (what transfer() runs as)
let owner: Pool; // connected as ledger_owner (funding + checks)

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: APP_POOL_SIZE });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  await resetLedger(owner);
});

afterEach(async () => {
  // Rule checked after EVERY test: cached balance = credits - debits, for every account.
  await expectLedgerReconciles(owner);
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

async function rowCounts(): Promise<{ transactions: number; entries: number }> {
  const { rows } = await owner.query<{ transactions: number; entries: number }>(
    `SELECT (SELECT count(*)::int FROM transactions) AS transactions,
            (SELECT count(*)::int FROM entries)      AS entries`,
  );
  return rows[0]!;
}

/** Readable summary of rejected promises, grouped: ["50 x InsufficientFundsError: ..."]. */
function describeRejections(results: PromiseSettledResult<unknown>[]): string[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r.status !== 'rejected') continue;
    const err = r.reason as { name?: string; code?: string; message?: string };
    const key = `${err.name ?? 'Error'}${err.code ? ` [${err.code}]` : ''}: ${err.message ?? String(r.reason)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${n} x ${key}`);
}

describe('transfer', () => {
  test('1. a transfer moves money: both balances change, exactly 2 entries, status posted', async () => {
    const a = await createAccount(app, 'user');
    const b = await createAccount(app, 'user');
    await fundAccount(owner, a, 10_000n);

    const { transactionId } = await transfer(app, {
      fromAccountId: a,
      toAccountId: b,
      amountPaise: 2_500n,
      note: 'dinner',
    });

    expect(await balanceOf(app, a)).toBe(7_500n);
    expect(await balanceOf(app, b)).toBe(2_500n);

    const entries = await app.query<{ account_id: string; direction: string; amount_paise: bigint }>(
      'SELECT account_id, direction, amount_paise FROM entries WHERE transaction_id = $1 ORDER BY direction',
      [transactionId],
    );
    expect(entries.rows).toEqual([
      { account_id: b, direction: 'credit', amount_paise: 2_500n },
      { account_id: a, direction: 'debit', amount_paise: 2_500n },
    ]);

    const tx = await app.query<{ kind: string; status: string; note: string | null; posted_at: Date | null }>(
      'SELECT kind, status, note, posted_at FROM transactions WHERE id = $1',
      [transactionId],
    );
    expect(tx.rows[0]).toMatchObject({ kind: 'transfer', status: 'posted', note: 'dinner', posted_at: expect.any(Date) });
  });

  test('2. invalid transfers are rejected with their own error class and write nothing', async () => {
    const a = await createAccount(app, 'user', 'INR');
    const b = await createAccount(app, 'user', 'INR');
    const usd = await createAccount(app, 'user', 'USD');
    await fundAccount(owner, a, 10_000n);
    const before = await rowCounts();

    await expect(transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: 0n })).rejects.toBeInstanceOf(
      InvalidAmountError,
    );
    await expect(transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: -100n })).rejects.toBeInstanceOf(
      InvalidAmountError,
    );
    await expect(transfer(app, { fromAccountId: a, toAccountId: a, amountPaise: 100n })).rejects.toBeInstanceOf(
      SameAccountError,
    );
    await expect(transfer(app, { fromAccountId: a, toAccountId: usd, amountPaise: 100n })).rejects.toBeInstanceOf(
      CurrencyMismatchError,
    );
    await expect(
      transfer(app, { fromAccountId: randomUUID(), toAccountId: b, amountPaise: 100n }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
    await expect(
      transfer(app, { fromAccountId: a, toAccountId: randomUUID(), amountPaise: 100n }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);

    expect(await rowCounts()).toEqual(before);
    expect(await balanceOf(app, a)).toBe(10_000n);
    expect(await balanceOf(app, b)).toBe(0n);
    expect(await balanceOf(app, usd)).toBe(0n);
  });

  test('3. insufficient funds is rejected and leaves no trace', async () => {
    const a = await createAccount(app, 'user');
    const b = await createAccount(app, 'user');
    await fundAccount(owner, a, 100n);
    const before = await rowCounts();

    await expect(transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: 101n })).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );

    expect(await rowCounts()).toEqual(before); // no transaction row, no entries
    expect(await balanceOf(app, a)).toBe(100n);
    expect(await balanceOf(app, b)).toBe(0n);
  });

  test(
    '4. 100 concurrent ₹1 transfers from an account holding ₹50: exactly 50 succeed',
    async () => {
      const a = await createAccount(app, 'user');
      const b = await createAccount(app, 'user');
      await fundAccount(owner, a, 5_000n); // ₹50

      const results = await Promise.allSettled(
        Array.from({ length: 100 }, () => transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: 100n })),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      const unexpected = failures.filter((r) => !(r.reason instanceof InsufficientFundsError));

      expect(describeRejections(unexpected)).toEqual([]);
      expect(succeeded).toHaveLength(50);
      expect(failures).toHaveLength(50);
      expect(await balanceOf(app, a)).toBe(0n);
      expect(await balanceOf(app, b)).toBe(5_000n);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  test(
    '5. 50 transfers A -> B and 50 B -> A at the same time all succeed without deadlocks',
    async () => {
      const a = await createAccount(app, 'user');
      const b = await createAccount(app, 'user');
      await fundAccount(owner, a, 5_000n);
      await fundAccount(owner, b, 5_000n);

      const transfers: Promise<unknown>[] = [];
      for (let i = 0; i < 50; i++) {
        transfers.push(transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: 100n }));
        transfers.push(transfer(app, { fromAccountId: b, toAccountId: a, amountPaise: 100n }));
      }
      const results = await Promise.allSettled(transfers);

      const deadlocks = results.filter(
        (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === PG.DEADLOCK_DETECTED,
      );
      expect(deadlocks).toHaveLength(0);
      expect(describeRejections(results)).toEqual([]); // all 100 succeeded

      const total = (await balanceOf(app, a)) + (await balanceOf(app, b));
      expect(total).toBe(10_000n); // no money created or destroyed
      expect(await balanceOf(app, a)).toBe(5_000n); // 50 out, 50 in
      expect(await balanceOf(app, b)).toBe(5_000n);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );
});
