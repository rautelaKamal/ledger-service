// Each test proves ONE rule the database itself enforces, no matter what the
// application code does.
//
// Isolation strategy (see docs/STEP-01-EXPLAINED.md):
//   * global-setup.ts TRUNCATEs all tables once, before the run (as the owner).
//   * Every test creates its own fresh accounts (new UUIDs), so tests never
//     share rows and do not depend on each other's order.
//   * Tests that only expect a rejection run inside BEGIN ... ROLLBACK.
//   * Tests that must really COMMIT leave their rows behind on purpose:
//     entries are append-only, so not even test code can delete them.
//     The next run's TRUNCATE removes them.
//
// Tests connect as ledger_app (what the API uses) unless the test is
// explicitly about the owner.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import {
  PG,
  commitBalancedTransaction,
  createAccount,
  createTransaction,
  insertEntry,
  withRollback,
} from './helpers.js';

let app: Pool; // connected as ledger_app
let owner: Pool; // connected as ledger_owner

beforeAll(() => {
  app = createPool(process.env.DATABASE_URL!);
  owner = createPool(process.env.OWNER_DATABASE_URL!);
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('database guarantees', () => {
  test('1. an entry with an amount of zero or a negative amount is rejected', async () => {
    const accountId = await createAccount(app, 'user');

    for (const amountPaise of [0n, -500n]) {
      await withRollback(app, async (db) => {
        const transactionId = await createTransaction(db);
        await expect(
          insertEntry(db, { transactionId, accountId, direction: 'debit', amountPaise }),
        ).rejects.toMatchObject({ code: PG.CHECK_VIOLATION, constraint: 'entries_amount_positive' });
      });
    }
  });

  test('2. the app cannot UPDATE or DELETE an entry, and even the owner is blocked by the trigger', async () => {
    const entryId = await commitBalancedTransaction(app, 10_000n);

    // ledger_app: stopped by missing GRANTs (permission error).
    await expect(app.query('UPDATE entries SET amount_paise = 1 WHERE id = $1', [entryId])).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    await expect(app.query('DELETE FROM entries WHERE id = $1', [entryId])).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });

    // ledger_owner HAS the privileges, but the append-only trigger stops it.
    await expect(owner.query('UPDATE entries SET amount_paise = 1 WHERE id = $1', [entryId])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/append-only: UPDATE/),
    });
    await expect(owner.query('DELETE FROM entries WHERE id = $1', [entryId])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/append-only: DELETE/),
    });

    // The entry is still there, unchanged.
    const { rows } = await app.query<{ amount_paise: bigint }>('SELECT amount_paise FROM entries WHERE id = $1', [entryId]);
    expect(rows[0]?.amount_paise).toBe(10_000n);
  });

  test("3. a transaction whose debits don't equal its credits fails at COMMIT, and a balanced one commits", async () => {
    const from = await createAccount(app, 'system');
    const to = await createAccount(app, 'user');
    const client = await app.connect();
    try {
      // Unbalanced: debit 100.00, credit 90.00.
      await client.query('BEGIN');
      const unbalancedId = await createTransaction(client);
      await insertEntry(client, { transactionId: unbalancedId, accountId: from, direction: 'debit', amountPaise: 10_000n });
      // Both INSERTs succeed: the check is deferred until COMMIT ...
      await insertEntry(client, { transactionId: unbalancedId, accountId: to, direction: 'credit', amountPaise: 9_000n });
      // ... and COMMIT is where it fails.
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: PG.CHECK_VIOLATION,
        message: expect.stringMatching(/unbalanced in INR: debits 10000 <> credits 9000/),
      });
      // A failed COMMIT rolls everything back, including the transaction row.
      const gone = await client.query('SELECT 1 FROM transactions WHERE id = $1', [unbalancedId]);
      expect(gone.rowCount).toBe(0);

      // Balanced: debit 100.00, credit 100.00. Really committed.
      await client.query('BEGIN');
      const balancedId = await createTransaction(client);
      await insertEntry(client, { transactionId: balancedId, accountId: from, direction: 'debit', amountPaise: 10_000n });
      await insertEntry(client, { transactionId: balancedId, accountId: to, direction: 'credit', amountPaise: 10_000n });
      await client.query('COMMIT');

      const saved = await client.query('SELECT 1 FROM entries WHERE transaction_id = $1', [balancedId]);
      expect(saved.rowCount).toBe(2);
    } finally {
      client.release();
    }
  });

  test("4. a user account's balance cannot go below 0, but a system account's can", async () => {
    const user = await createAccount(app, 'user');
    const system = await createAccount(app, 'system');

    await expect(app.query('UPDATE accounts SET balance_paise = -1 WHERE id = $1', [user])).rejects.toMatchObject({
      code: PG.CHECK_VIOLATION,
      constraint: 'accounts_user_balance_not_negative',
    });

    await app.query('UPDATE accounts SET balance_paise = -50000 WHERE id = $1', [system]);
    const { rows } = await app.query<{ balance_paise: bigint }>('SELECT balance_paise FROM accounts WHERE id = $1', [system]);
    expect(rows[0]?.balance_paise).toBe(-50_000n); // a real bigint, not a JS number
  });

  test("5. an entry whose currency differs from its account's currency is rejected", async () => {
    const inrAccount = await createAccount(app, 'user', 'INR');

    await withRollback(app, async (db) => {
      const transactionId = await createTransaction(db);
      await expect(
        insertEntry(db, { transactionId, accountId: inrAccount, currency: 'USD', direction: 'credit', amountPaise: 100n }),
      ).rejects.toMatchObject({ code: PG.FOREIGN_KEY_VIOLATION, constraint: 'entries_account_currency_fkey' });
    });
  });

  test("6. a posted transaction's status cannot be changed", async () => {
    const id = await createTransaction(app, 'pending');

    // pending -> posted is allowed (posted_at must be set at the same time).
    await app.query(`UPDATE transactions SET status = 'posted', posted_at = now() WHERE id = $1`, [id]);

    // posted -> anything is not.
    await expect(
      app.query(`UPDATE transactions SET status = 'failed', posted_at = NULL WHERE id = $1`, [id]),
    ).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/is posted and can no longer be changed/),
    });
  });

  test('7. the app role cannot TRUNCATE entries', async () => {
    const { rows } = await app.query<{ allowed: boolean }>(
      `SELECT has_table_privilege('ledger_app', 'entries', 'TRUNCATE') AS allowed`,
    );
    expect(rows[0]?.allowed).toBe(false);

    await expect(app.query('TRUNCATE entries')).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
  });

  test("8. the app cannot choose an account's starting balance or an entry's created_at", async () => {
    // Setting balance_paise on INSERT is not granted (any value, even 0).
    await expect(
      app.query(`INSERT INTO accounts (name, kind, currency, balance_paise) VALUES ('rich', 'user', 'INR', 100000000)`),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });

    // The database fills the starting balance itself.
    const { rows } = await app.query<{ id: string; balance_paise: bigint }>(
      `INSERT INTO accounts (name, kind, currency) VALUES ('normal', 'user', 'INR') RETURNING id, balance_paise`,
    );
    expect(rows[0]?.balance_paise).toBe(0n);

    // Backdating an entry is not granted either.
    await withRollback(app, async (db) => {
      const transactionId = await createTransaction(db);
      await expect(
        db.query(
          `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise, created_at)
           VALUES ($1, $2, 'INR', 'credit', 100, '2020-01-01')`,
          [transactionId, rows[0]!.id],
        ),
      ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    });
  });
});
