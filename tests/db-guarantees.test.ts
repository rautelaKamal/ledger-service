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
  postTransaction,
  withCommit,
  withRollback,
} from './helpers.js';

let app: Pool; // connected as ledger_app
let owner: Pool; // connected as ledger_owner
let worker: Pool; // connected as ledger_worker (step 5)
let reconciler: Pool; // connected as ledger_reconciler (step 5)

beforeAll(() => {
  app = createPool(process.env.DATABASE_URL!);
  owner = createPool(process.env.OWNER_DATABASE_URL!);
  worker = createPool(process.env.WORKER_DATABASE_URL!, { max: 2 });
  reconciler = createPool(process.env.RECONCILER_DATABASE_URL!, { max: 2 });
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await worker.end();
  await reconciler.end();
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
    const { debitEntryId: entryId } = await commitBalancedTransaction(app, 10_000n);

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
      await postTransaction(client, unbalancedId);
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
      await postTransaction(client, balancedId);
      await client.query('COMMIT');

      const saved = await client.query('SELECT 1 FROM entries WHERE transaction_id = $1', [balancedId]);
      expect(saved.rowCount).toBe(2);
    } finally {
      // If an assertion failed mid-transaction, don't hand an aborted
      // transaction back to the pool. (Outside a transaction this is a no-op.)
      await client.query('ROLLBACK');
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
    // pending -> posted is allowed (with balanced entries, see migration 002).
    const { transactionId: id } = await commitBalancedTransaction(app, 100n);

    // posted -> anything is not.
    await expect(app.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [id])).rejects.toMatchObject({
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

  // ─────────────── Step 2: transaction lifecycle (migration 002) ───────────────

  test('9. a new transaction always starts as pending: the app cannot insert status or posted_at', async () => {
    await expect(
      app.query(`INSERT INTO transactions (kind, status) VALUES ('transfer', 'posted')`),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(`INSERT INTO transactions (kind, posted_at) VALUES ('transfer', now())`),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });

    const { rows } = await app.query<{ status: string; posted_at: Date | null }>(
      `INSERT INTO transactions (kind) VALUES ('transfer') RETURNING status, posted_at`,
    );
    expect(rows[0]).toEqual({ status: 'pending', posted_at: null });
  });

  test('10. entries cannot be added to a posted or a failed transaction', async () => {
    const { transactionId: postedId } = await commitBalancedTransaction(app, 100n);
    const failedId = await createTransaction(app);
    await app.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [failedId]);
    const accountId = await createAccount(app, 'user');

    for (const [transactionId, status] of [
      [postedId, 'posted'],
      [failedId, 'failed'],
    ] as const) {
      await withRollback(app, async (db) => {
        await expect(
          insertEntry(db, { transactionId, accountId, direction: 'credit', amountPaise: 100n }),
        ).rejects.toMatchObject({
          code: PG.RAISE_EXCEPTION,
          message: expect.stringMatching(new RegExp(`it is ${status} \\(only pending transactions accept entries\\)`)),
        });
      });
    }
  });

  test("11. the app can add an entry to a pending transaction (rule 2's row lock works under the app's grants)", async () => {
    const accountId = await createAccount(app, 'user');

    await withRollback(app, async (db) => {
      const transactionId = await createTransaction(db);
      await insertEntry(db, { transactionId, accountId, direction: 'credit', amountPaise: 100n });
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM entries WHERE transaction_id = $1',
        [transactionId],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });

  test('12. a transaction cannot be posted with fewer than 2 entries', async () => {
    const accountId = await createAccount(app, 'user');

    await withRollback(app, async (db) => {
      const transactionId = await createTransaction(db);
      await expect(postTransaction(db, transactionId)).rejects.toMatchObject({
        code: PG.RAISE_EXCEPTION,
        message: expect.stringMatching(/it has 0 entries, at least 2 are required/),
      });
    });

    await withRollback(app, async (db) => {
      const transactionId = await createTransaction(db);
      await insertEntry(db, { transactionId, accountId, direction: 'credit', amountPaise: 100n });
      await expect(postTransaction(db, transactionId)).rejects.toMatchObject({
        code: PG.RAISE_EXCEPTION,
        message: expect.stringMatching(/it has 1 entries, at least 2 are required/),
      });
    });
  });

  test('13. a transaction that has entries cannot be marked failed, but an empty one can', async () => {
    const from = await createAccount(app, 'system');
    const to = await createAccount(app, 'user');

    await withRollback(app, async (db) => {
      const transactionId = await createTransaction(db);
      await insertEntry(db, { transactionId, accountId: from, direction: 'debit', amountPaise: 100n });
      await insertEntry(db, { transactionId, accountId: to, direction: 'credit', amountPaise: 100n });
      await expect(
        db.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [transactionId]),
      ).rejects.toMatchObject({
        code: PG.RAISE_EXCEPTION,
        message: expect.stringMatching(/cannot mark transaction .* as failed: it already has 2 entries/),
      });
    });

    const emptyId = await createTransaction(app);
    await app.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [emptyId]);
    const { rows } = await app.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [emptyId]);
    expect(rows[0]?.status).toBe('failed');
  });

  test('14. posted_at is stamped by the database when, and only when, a transaction is posted', async () => {
    const pendingId = await createTransaction(app);

    // The app has no privilege to write posted_at ...
    await expect(
      app.query('UPDATE transactions SET posted_at = now() WHERE id = $1', [pendingId]),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    // ... and even the owner is stopped by the trigger.
    await expect(
      owner.query('UPDATE transactions SET posted_at = now() WHERE id = $1', [pendingId]),
    ).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/posted_at is set by the database/),
    });

    // Failing does not stamp it.
    await app.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [pendingId]);
    // Posting does.
    const { transactionId: postedId } = await commitBalancedTransaction(app, 100n);

    const { rows } = await app.query<{ id: string; status: string; posted_at: Date | null }>(
      'SELECT id, status, posted_at FROM transactions WHERE id = ANY($1::uuid[])',
      [[pendingId, postedId]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(pendingId)).toMatchObject({ status: 'failed', posted_at: null });
    expect(byId.get(postedId)).toMatchObject({ status: 'posted', posted_at: expect.any(Date) });
  });

  test('15. entries whose transaction is never flipped to posted make COMMIT fail', async () => {
    const from = await createAccount(app, 'system');
    const to = await createAccount(app, 'user');
    let transactionId = '';

    await expect(
      withCommit(app, async (db) => {
        transactionId = await createTransaction(db);
        await insertEntry(db, { transactionId, accountId: from, direction: 'debit', amountPaise: 100n });
        await insertEntry(db, { transactionId, accountId: to, direction: 'credit', amountPaise: 100n });
        // balanced, but never posted
      }),
    ).rejects.toMatchObject({
      code: PG.CHECK_VIOLATION,
      message: expect.stringMatching(/has entries but is pending at COMMIT/),
    });

    const gone = await app.query('SELECT 1 FROM transactions WHERE id = $1', [transactionId]);
    expect(gone.rowCount).toBe(0);
  });

  // ─────────────── Step 3: idempotency_keys (migration 003) ───────────────

  test('16. the app cannot delete a live idempotency key, but can delete an expired one', async () => {
    await owner.query(
      `INSERT INTO idempotency_keys (client_id, key, request_hash, response_status, response_body, created_at, expires_at)
       VALUES ('c', 'live',    repeat('a', 64), 201, '{}', now(), now() + interval '1 hour'),
              ('c', 'expired', repeat('b', 64), 201, '{}', now() - interval '2 days', now() - interval '1 day')`,
    );

    await expect(app.query(`DELETE FROM idempotency_keys WHERE client_id = 'c' AND key = 'live'`)).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/has not expired .* and cannot be deleted/),
    });
    const deleted = await app.query(`DELETE FROM idempotency_keys WHERE client_id = 'c' AND key = 'expired'`);
    expect(deleted.rowCount).toBe(1);
  });

  test('17. an idempotency key with a stored response is frozen, even for the owner', async () => {
    await owner.query(
      `INSERT INTO idempotency_keys (client_id, key, request_hash, response_status, response_body)
       VALUES ('c', 'done', repeat('c', 64), 201, '{"transactionId":"x"}')`,
    );

    await expect(
      app.query(`UPDATE idempotency_keys SET response_status = 500 WHERE client_id = 'c' AND key = 'done'`),
    ).rejects.toMatchObject({ code: PG.RAISE_EXCEPTION, message: expect.stringMatching(/already has a stored response/) });
    await expect(
      owner.query(`UPDATE idempotency_keys SET response_body = '{}' WHERE client_id = 'c' AND key = 'done'`),
    ).rejects.toMatchObject({ code: PG.RAISE_EXCEPTION, message: expect.stringMatching(/already has a stored response/) });
    await expect(
      owner.query(`UPDATE idempotency_keys SET expires_at = now() WHERE client_id = 'c' AND key = 'done'`),
    ).rejects.toMatchObject({ code: PG.RAISE_EXCEPTION, message: expect.stringMatching(/are immutable/) });
  });

  test("18. the app cannot insert a response or choose an idempotency key's expiry", async () => {
    await expect(
      app.query(
        `INSERT INTO idempotency_keys (client_id, key, request_hash, response_status, response_body)
         VALUES ('c', 'k1', repeat('d', 64), 201, '{}')`,
      ),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(
        `INSERT INTO idempotency_keys (client_id, key, request_hash, expires_at)
         VALUES ('c', 'k2', repeat('d', 64), now() + interval '10 years')`,
      ),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });

    // The database fills the timing columns.
    const { rows } = await app.query<{ hours: number }>(
      `INSERT INTO idempotency_keys (client_id, key, request_hash) VALUES ('c', 'k3', repeat('d', 64))
       RETURNING round(extract(epoch FROM (expires_at - created_at)) / 3600)::int AS hours`,
    );
    expect(rows[0]?.hours).toBe(24);
  });

  // ─────────────── Step 4: topups and webhook_events (migration 004) ───────────────

  // Step 5: the API inserts the topups row WITHOUT a paymentId; the worker records it later, once.
  async function pendingTopup(): Promise<{ transactionId: string; accountId: string }> {
    const accountId = await createAccount(app, 'user');
    const { rows } = await app.query<{ id: string }>(`INSERT INTO transactions (kind) VALUES ('topup') RETURNING id`);
    await app.query(
      `INSERT INTO topups (transaction_id, account_id, currency, amount_paise) VALUES ($1, $2, 'INR', 100)`,
      [rows[0]!.id, accountId],
    );
    await worker.query('UPDATE topups SET provider_payment_id = $2 WHERE transaction_id = $1', [rows[0]!.id, `pay_${rows[0]!.id}`]);
    return { transactionId: rows[0]!.id, accountId };
  }

  test('19. topups are append-only: the app lacks the grants, and the trigger stops even the owner', async () => {
    const { transactionId } = await pendingTopup();

    await expect(app.query('UPDATE topups SET amount_paise = 1 WHERE transaction_id = $1', [transactionId])).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    await expect(app.query('DELETE FROM topups WHERE transaction_id = $1', [transactionId])).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    await expect(owner.query('UPDATE topups SET amount_paise = 1 WHERE transaction_id = $1', [transactionId])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/topups are append-only/),
    });
    await expect(owner.query('DELETE FROM topups WHERE transaction_id = $1', [transactionId])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/topups are append-only: DELETE/),
    });
  });

  test('20. webhook_events are append-only: the app lacks the grants, and the trigger stops even the owner', async () => {
    await owner.query(
      `INSERT INTO webhook_events (provider_event_id, event_type, provider_payment_id, raw_body, result)
       VALUES ('evt_frozen', 'payment.succeeded', 'pay_x', '{}', 'unmatched')`,
    );

    await expect(app.query(`UPDATE webhook_events SET result = 'posted' WHERE provider_event_id = 'evt_frozen'`)).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    await expect(app.query(`DELETE FROM webhook_events WHERE provider_event_id = 'evt_frozen'`)).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    await expect(owner.query(`UPDATE webhook_events SET result_detail = 'x' WHERE provider_event_id = 'evt_frozen'`)).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/webhook_events are append-only: UPDATE/),
    });
    await expect(owner.query(`DELETE FROM webhook_events WHERE provider_event_id = 'evt_frozen'`)).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/webhook_events are append-only: DELETE/),
    });
  });

  test('21. the app cannot set created_at / received_at on topups or webhook_events; the database fills them', async () => {
    const accountId = await createAccount(app, 'user');
    const { rows } = await app.query<{ id: string }>(`INSERT INTO transactions (kind) VALUES ('topup') RETURNING id`);

    await expect(
      app.query(
        `INSERT INTO topups (transaction_id, account_id, currency, amount_paise, created_at)
         VALUES ($1, $2, 'INR', 100, '2020-01-01')`,
        [rows[0]!.id, accountId],
      ),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(
      app.query(
        `INSERT INTO webhook_events (provider_event_id, event_type, provider_payment_id, raw_body, result, received_at)
         VALUES ('evt_backdated', 'payment.succeeded', 'pay_x', '{}', 'unmatched', '2020-01-01')`,
      ),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });

    const inserted = await app.query<{ fresh: boolean }>(
      `INSERT INTO webhook_events (provider_event_id, event_type, provider_payment_id, raw_body, result)
       VALUES ('evt_fresh', 'payment.succeeded', 'pay_x', '{}', 'unmatched')
       RETURNING received_at > now() - interval '5 seconds' AS fresh`,
    );
    expect(inserted.rows[0]?.fresh).toBe(true);
  });

  test('22. a topups row can only point at a pending topup transaction, and a payment confirms at most one top-up', async () => {
    const accountId = await createAccount(app, 'user');

    // not a top-up
    const transferTx = await createTransaction(app, 'transfer');
    await expect(
      app.query(`INSERT INTO topups (transaction_id, account_id, currency, amount_paise) VALUES ($1, $2, 'INR', 100)`, [transferTx, accountId]),
    ).rejects.toMatchObject({ code: PG.RAISE_EXCEPTION, message: expect.stringMatching(/kind topup, not transfer/) });

    // a top-up that is already final
    const failedTx = await createTransaction(app, 'topup');
    await app.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [failedTx]);
    await expect(
      app.query(`INSERT INTO topups (transaction_id, account_id, currency, amount_paise) VALUES ($1, $2, 'INR', 100)`, [failedTx, accountId]),
    ).rejects.toMatchObject({ code: PG.RAISE_EXCEPTION, message: expect.stringMatching(/while its transaction is pending, not failed/) });

    // one payment id, two top-ups (the worker records the id; the second recording collides)
    const { transactionId } = await pendingTopup();
    const { rows } = await app.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM topups WHERE transaction_id = $1', [transactionId]);
    const another = await createTransaction(app, 'topup');
    await app.query(`INSERT INTO topups (transaction_id, account_id, currency, amount_paise) VALUES ($1, $2, 'INR', 100)`, [another, accountId]);
    await expect(
      worker.query('UPDATE topups SET provider_payment_id = $2 WHERE transaction_id = $1', [another, rows[0]!.provider_payment_id]),
    ).rejects.toMatchObject({ code: PG.UNIQUE_VIOLATION, constraint: 'topups_provider_payment_id_key' });
  });

  test('23. there is at most one bank_settlement account per currency', async () => {
    await expect(
      owner.query(`INSERT INTO accounts (name, kind, currency) VALUES ('bank_settlement', 'system', 'INR')`),
    ).rejects.toMatchObject({ code: PG.UNIQUE_VIOLATION, constraint: 'accounts_one_bank_settlement_per_currency' });
    // A USER account may be called anything, including bank_settlement.
    await createAccount(app, 'user', 'INR', 'bank_settlement');
  });

  // ─────────────── Step 5: outbox, roles, reconciliation_runs (migration 005) ───────────────

  test('24. each role can do only its own job on the outbox: app inserts, worker marks, reconciler reads', async () => {
    // app: may queue work, may not see or touch it
    const queued = await app.query(`INSERT INTO outbox (type, payload) VALUES ('transfer.posted', '{"t":1}')`);
    expect(queued.rowCount).toBe(1);
    await expect(app.query('SELECT id FROM outbox')).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(app.query(`UPDATE outbox SET status = 'sent', sent_at = now()`)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(app.query(`INSERT INTO outbox (type, payload, status) VALUES ('transfer.posted', '{}', 'sent')`)).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });

    // worker: may read and mark, may not create work or touch the ledger
    const { rows } = await worker.query<{ id: bigint }>(`SELECT id FROM outbox WHERE status = 'pending' ORDER BY id DESC LIMIT 1`);
    const id = rows[0]!.id;
    await expect(worker.query(`INSERT INTO outbox (type, payload) VALUES ('transfer.posted', '{}')`)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(worker.query(`UPDATE outbox SET payload = '{}' WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(worker.query('SELECT 1 FROM accounts')).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(worker.query('SELECT 1 FROM entries')).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(worker.query(`UPDATE accounts SET balance_paise = 0`)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    const marked = await worker.query(`UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
    expect(marked.rowCount).toBe(1);

    // reconciler: may read everything it checks, may not change anything
    for (const table of ['accounts', 'entries', 'transactions', 'topups', 'webhook_events', 'outbox']) {
      await reconciler.query(`SELECT 1 FROM ${table} LIMIT 1`);
    }
    await expect(reconciler.query(`UPDATE outbox SET status = 'dead', last_error = 'x' WHERE id = $1`, [id])).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    await expect(reconciler.query(`UPDATE topups SET provider_payment_id = 'x'`)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(reconciler.query(`INSERT INTO outbox (type, payload) VALUES ('transfer.posted', '{}')`)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
  });

  test('25. an outbox row is frozen once sent or dead, attempts never decrease, and only sent rows may be deleted', async () => {
    const ids = await owner.query<{ id: bigint }>(
      `INSERT INTO outbox (type, payload) VALUES ('transfer.posted', '{"a":1}'), ('transfer.posted', '{"a":2}'), ('transfer.posted', '{"a":3}') RETURNING id`,
    );
    const [pending, toSend, toDie] = ids.rows.map((r) => r.id);

    // bookkeeping on a pending row is fine, but attempts only go up and the facts are immutable
    await worker.query(`UPDATE outbox SET attempts = 2, last_error = 'boom', available_at = now() + interval '1 minute' WHERE id = $1`, [pending]);
    await expect(worker.query(`UPDATE outbox SET attempts = 1 WHERE id = $1`, [pending])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/attempts cannot decrease/),
    });
    await expect(owner.query(`UPDATE outbox SET payload = '{"a":9}' WHERE id = $1`, [pending])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/immutable/),
    });

    // sent: frozen
    await worker.query(`UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = $1`, [toSend]);
    await expect(worker.query(`UPDATE outbox SET status = 'pending', sent_at = NULL WHERE id = $1`, [toSend])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/already sent/),
    });
    // dead: needs a reason, then frozen
    await expect(worker.query(`UPDATE outbox SET status = 'dead' WHERE id = $1`, [toDie])).rejects.toMatchObject({
      code: PG.CHECK_VIOLATION,
      constraint: 'outbox_dead_has_error',
    });
    await worker.query(`UPDATE outbox SET status = 'dead', attempts = 8, last_error = 'gave up' WHERE id = $1`, [toDie]);
    await expect(owner.query(`UPDATE outbox SET status = 'pending' WHERE id = $1`, [toDie])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/already dead/),
    });

    // delete: nobody but the owner has the grant, and even the owner only for sent rows
    await expect(worker.query('DELETE FROM outbox WHERE id = $1', [toSend])).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(owner.query('DELETE FROM outbox WHERE id = $1', [pending])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/cannot be deleted/),
    });
    await expect(owner.query('DELETE FROM outbox WHERE id = $1', [toDie])).rejects.toMatchObject({ code: PG.RAISE_EXCEPTION });
    expect((await owner.query('DELETE FROM outbox WHERE id = $1', [toSend])).rowCount).toBe(1);
  });

  test("26. a top-up's paymentId can be recorded exactly once, by the worker, and nothing else about it can change", async () => {
    const accountId = await createAccount(app, 'user');
    const { rows } = await app.query<{ id: string }>(`INSERT INTO transactions (kind) VALUES ('topup') RETURNING id`);
    const topupId = rows[0]!.id;
    await app.query(`INSERT INTO topups (transaction_id, account_id, currency, amount_paise) VALUES ($1, $2, 'INR', 100)`, [topupId, accountId]);

    // the API cannot record it at all
    await expect(app.query(`UPDATE topups SET provider_payment_id = 'pay_app' WHERE transaction_id = $1`, [topupId])).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    // the worker can, once
    expect((await worker.query(`UPDATE topups SET provider_payment_id = 'pay_first' WHERE transaction_id = $1`, [topupId])).rowCount).toBe(1);
    await expect(worker.query(`UPDATE topups SET provider_payment_id = 'pay_second' WHERE transaction_id = $1`, [topupId])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/only provider_payment_id may be set, once/),
    });
    // and nothing else, even combined with the permitted write, even by the owner
    await expect(
      owner.query(`UPDATE topups SET provider_payment_id = 'pay_x', amount_paise = 1 WHERE transaction_id = $1`, [topupId]),
    ).rejects.toMatchObject({ code: PG.RAISE_EXCEPTION });
    await expect(owner.query(`UPDATE topups SET provider_payment_id = NULL WHERE transaction_id = $1`, [topupId])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
    });
  });

  test('27. reconciliation_runs are append-only and ok must agree with the problems list', async () => {
    const inserted = await reconciler.query<{ id: bigint }>(
      `INSERT INTO reconciliation_runs (ok, duration_ms, summary, problems) VALUES (true, 12, '{"account_balances":0}', '[]') RETURNING id`,
    );
    const id = inserted.rows[0]!.id;

    await expect(
      reconciler.query(`INSERT INTO reconciliation_runs (ok, duration_ms, summary, problems) VALUES (true, 1, '{}', '[{"check":"x"}]')`),
    ).rejects.toMatchObject({ code: PG.CHECK_VIOLATION, constraint: 'reconciliation_runs_ok_matches_problems' });
    await expect(
      reconciler.query(`INSERT INTO reconciliation_runs (ok, duration_ms, summary, problems, ran_at) VALUES (true, 1, '{}', '[]', '2020-01-01')`),
    ).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(reconciler.query(`UPDATE reconciliation_runs SET ok = false WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(owner.query(`UPDATE reconciliation_runs SET ok = false WHERE id = $1`, [id])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/append-only: UPDATE/),
    });
    await expect(owner.query(`DELETE FROM reconciliation_runs WHERE id = $1`, [id])).rejects.toMatchObject({
      code: PG.RAISE_EXCEPTION,
      message: expect.stringMatching(/append-only: DELETE/),
    });
    await expect(app.query('SELECT 1 FROM reconciliation_runs')).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
  });

  test('28. the database fills outbox timing columns; the app and worker cannot choose them', async () => {
    await expect(app.query(`INSERT INTO outbox (type, payload, available_at) VALUES ('transfer.posted', '{}', '2030-01-01')`)).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    await expect(app.query(`INSERT INTO outbox (type, payload, created_at) VALUES ('transfer.posted', '{}', '2020-01-01')`)).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    await app.query(`INSERT INTO outbox (type, payload) VALUES ('transfer.posted', '{"fresh":true}')`);
    const { rows } = await worker.query<{ fresh: boolean; status: string; attempts: number }>(
      `SELECT created_at > now() - interval '5 seconds' AND available_at <= now() AS fresh, status, attempts
         FROM outbox WHERE payload->>'fresh' = 'true' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ fresh: true, status: 'pending', attempts: 0 });
    await expect(worker.query(`UPDATE outbox SET created_at = now() WHERE payload->>'fresh' = 'true'`)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
  });
});
