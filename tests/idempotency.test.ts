// Tests for POST /transfers with Idempotency-Key, over real HTTP against the
// real app and the real database (ledger_test).
//
// Setup: like the transfer tests, beforeAll TRUNCATEs the ledger (as owner),
// accounts are funded with fundAccount(), and afterEach checks the whole
// ledger reconciles. Tests run as ledger_app except where noted.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import { deleteExpiredIdempotencyKeys, runIdempotent } from '../src/idempotency.js';
import { balanceOf, createAccount, expectLedgerReconciles, fundAccount } from './helpers.js';
import { postTransfer, startTestServer, type TestServer } from './http.js';
import { resetLedger } from './reset.js';

let app: Pool; // ledger_app
let owner: Pool; // ledger_owner
let server: TestServer;

const CLIENT = 'test-client';
const newKey = (): string => `key-${randomUUID()}`;

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: 20 });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  await resetLedger(owner);
  server = await startTestServer(app);
});

afterEach(async () => {
  await expectLedgerReconciles(owner);
});

afterAll(async () => {
  await server.close();
  await app.end();
  await owner.end();
});

/** Two funded INR accounts and a ready-to-send body. */
async function setupPair(fundPaise = 10_000n): Promise<{ a: string; b: string; body: Record<string, string> }> {
  const a = await createAccount(app, 'user');
  const b = await createAccount(app, 'user');
  if (fundPaise > 0n) await fundAccount(owner, a, fundPaise);
  return { a, b, body: { fromAccountId: a, toAccountId: b, amountPaise: '2500' } };
}

async function transactionCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM transactions WHERE kind = 'transfer'`);
  return rows[0]!.n;
}

async function keyCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM idempotency_keys');
  return rows[0]!.n;
}

describe('POST /transfers with Idempotency-Key', () => {
  test('1. a transfer over HTTP moves money once and returns 201 with the transaction id', async () => {
    const { a, b, body } = await setupPair();

    const res = await postTransfer(server.url, { key: newKey(), clientId: CLIENT, body });

    expect(res.status).toBe(201);
    expect(res.json).toEqual({ transactionId: expect.any(String) });
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    expect(await balanceOf(app, a)).toBe(7_500n);
    expect(await balanceOf(app, b)).toBe(2_500n);
  });

  test('2. a retry with the same key and body replays the stored 201; money moves once', async () => {
    const { a, b, body } = await setupPair();
    const key = newKey();
    const before = await transactionCount();

    const first = await postTransfer(server.url, { key, clientId: CLIENT, body });
    const retry = await postTransfer(server.url, { key, clientId: CLIENT, body });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.json).toEqual(first.json); // same transactionId
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(await transactionCount()).toBe(before + 1);
    expect(await balanceOf(app, a)).toBe(7_500n);
    expect(await balanceOf(app, b)).toBe(2_500n);
  });

  test('3. the same key with a different body is rejected with 422 and nothing happens', async () => {
    const { a, b, body } = await setupPair();
    const key = newKey();
    await postTransfer(server.url, { key, clientId: CLIENT, body });
    const before = await transactionCount();

    const res = await postTransfer(server.url, { key, clientId: CLIENT, body: { ...body, amountPaise: '2600' } });

    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    expect(await transactionCount()).toBe(before);
    expect(await balanceOf(app, a)).toBe(7_500n);
    expect(await balanceOf(app, b)).toBe(2_500n);
  });

  test('4. 20 identical concurrent requests: one transfer, all get the same 201, 19 replayed', async () => {
    const { a, b, body } = await setupPair();
    const key = newKey();
    const before = await transactionCount();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => postTransfer(server.url, { key, clientId: CLIENT, body })),
    );

    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const ids = new Set(results.map((r) => (r.json as { transactionId: string }).transactionId));
    expect(ids.size).toBe(1);
    const replayed = results.filter((r) => r.headers.get('idempotent-replayed') === 'true');
    expect(replayed).toHaveLength(19);
    expect(await transactionCount()).toBe(before + 1);
    expect(await balanceOf(app, a)).toBe(7_500n);
    expect(await balanceOf(app, b)).toBe(2_500n);
  });

  test('5. a business error (insufficient funds) is stored and replayed; it does not succeed later', async () => {
    const { a, b, body } = await setupPair(0n); // a has nothing
    const key = newKey();

    const first = await postTransfer(server.url, { key, clientId: CLIENT, body });
    expect(first.status).toBe(422);
    expect(first.json).toMatchObject({ error: { code: 'insufficient_funds' } });

    // Now a CAN afford it ...
    await fundAccount(owner, a, 10_000n);
    // ... but the same key still returns the stored answer.
    const retry = await postTransfer(server.url, { key, clientId: CLIENT, body });
    expect(retry.status).toBe(422);
    expect(retry.json).toEqual(first.json);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(await balanceOf(app, b)).toBe(0n);

    // A new key is a new request.
    const fresh = await postTransfer(server.url, { key: newKey(), clientId: CLIENT, body });
    expect(fresh.status).toBe(201);
    expect(await balanceOf(app, b)).toBe(2_500n);
  });

  test('6. an unexpected error is not stored, so the next attempt with the same key runs', async () => {
    const scope = { clientId: CLIENT, key: newKey(), requestHash: 'a'.repeat(64) };
    const before = await keyCount();

    await expect(
      runIdempotent(app, scope, async () => {
        throw new Error('database exploded');
      }),
    ).rejects.toThrow('database exploded');
    expect(await keyCount()).toBe(before);

    const second = await runIdempotent(app, scope, async () => ({ status: 201, body: { ok: true } }));
    expect(second).toEqual({ status: 201, body: { ok: true }, replayed: false });
    expect(await keyCount()).toBe(before + 1);
  });

  test('7. keys are scoped per client: the same key from two clients is two transfers', async () => {
    const { a, b, body } = await setupPair();
    const key = newKey();

    const one = await postTransfer(server.url, { key, clientId: 'client-one', body });
    const two = await postTransfer(server.url, { key, clientId: 'client-two', body });

    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.headers.get('idempotent-replayed')).toBeNull();
    expect(two.json).not.toEqual(one.json);
    expect(await balanceOf(app, a)).toBe(5_000n);
    expect(await balanceOf(app, b)).toBe(5_000n);
  });

  test('8. an expired key is treated as new, and cleanup deletes expired keys only', async () => {
    const { a, b, body } = await setupPair();
    const key = newKey();

    // Simulate a key stored yesterday (as owner: the app cannot set these columns).
    await owner.query(
      `INSERT INTO idempotency_keys
         (client_id, key, request_hash, response_status, response_body, created_at, expires_at)
       VALUES ($1, $2, repeat('0', 64), 201, '{"transactionId":"old"}', now() - interval '25 hours', now() - interval '1 hour')`,
      [CLIENT, key],
    );

    const res = await postTransfer(server.url, { key, clientId: CLIENT, body });
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    expect(res.json).not.toEqual({ transactionId: 'old' });
    expect(await balanceOf(app, a)).toBe(7_500n);
    expect(await balanceOf(app, b)).toBe(2_500n);

    // Cleanup: two more expired rows and one live row (the one just created).
    for (const k of ['stale-1', 'stale-2']) {
      await owner.query(
        `INSERT INTO idempotency_keys
           (client_id, key, request_hash, response_status, response_body, created_at, expires_at)
         VALUES ($1, $2, repeat('0', 64), 201, '{}', now() - interval '2 days', now() - interval '1 day')`,
        [CLIENT, k],
      );
    }
    const liveBefore = await keyCount();
    const deleted = await deleteExpiredIdempotencyKeys(app);
    expect(deleted).toBe(2);
    expect(await keyCount()).toBe(liveBefore - 2);
    const { rows } = await owner.query('SELECT 1 FROM idempotency_keys WHERE client_id = $1 AND key = $2', [CLIENT, key]);
    expect(rows).toHaveLength(1); // the live key survived
  });

  test('9. malformed requests are rejected with 400/401 and nothing is stored', async () => {
    const { body } = await setupPair();
    const before = { tx: await transactionCount(), keys: await keyCount() };
    const send = (overrides: Partial<Parameters<typeof postTransfer>[1]>) =>
      postTransfer(server.url, { key: newKey(), clientId: CLIENT, body, ...overrides });

    // Headers
    expect((await send({ clientId: undefined })).status).toBe(401);
    expect((await send({ key: undefined })).status).toBe(400);
    expect((await send({ key: 'x'.repeat(256) })).status).toBe(400);

    // Body
    expect((await send({ rawBody: '{not json' })).status).toBe(400);
    expect((await send({ body: { ...body, extra: 1 } })).status).toBe(400); // .strict()
    expect((await send({ body: { ...body, fromAccountId: 'not-a-uuid' } })).status).toBe(400);
    for (const amountPaise of ['1.5', '-3', '1e3', '', 100]) {
      const res = await send({ body: { ...body, amountPaise } });
      expect(res.status, `amountPaise ${JSON.stringify(amountPaise)}`).toBe(400);
      expect(res.json).toMatchObject({ error: { code: 'invalid_body' } });
    }

    expect(await transactionCount()).toBe(before.tx);
    expect(await keyCount()).toBe(before.keys);
  });

  test(
    '10. a duplicate that waits more than 5 s for the first request gets 409 with Retry-After',
    async () => {
      const { body } = await setupPair();
      const key = newKey();

      // Hold the key in an open transaction, as a slow first request would.
      const holder = await app.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO idempotency_keys (client_id, key, request_hash) VALUES ($1, $2, repeat('0', 64))`,
          [CLIENT, key],
        );

        const started = Date.now();
        const res = await postTransfer(server.url, { key, clientId: CLIENT, body });
        const waited = Date.now() - started;

        expect(res.status).toBe(409);
        expect(res.headers.get('retry-after')).toBe('1');
        expect(res.json).toMatchObject({ error: { code: 'request_in_progress' } });
        expect(waited).toBeGreaterThanOrEqual(4_500); // it did wait, then gave up
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    },
    20_000,
  );

  test('11. business error responses map to the agreed status codes', async () => {
    const { a, b, body } = await setupPair();
    const usd = await createAccount(app, 'user', 'USD');
    const send = (b2: Record<string, string>) => postTransfer(server.url, { key: newKey(), clientId: CLIENT, body: b2 });

    expect(await send({ ...body, amountPaise: '0' })).toMatchObject({ status: 400, json: { error: { code: 'invalid_amount' } } });
    expect(await send({ ...body, toAccountId: a })).toMatchObject({ status: 400, json: { error: { code: 'same_account' } } });
    expect(await send({ ...body, toAccountId: randomUUID() })).toMatchObject({ status: 404, json: { error: { code: 'account_not_found' } } });
    expect(await send({ ...body, toAccountId: usd })).toMatchObject({ status: 422, json: { error: { code: 'currency_mismatch' } } });
    expect(await send({ ...body, amountPaise: '999999' })).toMatchObject({ status: 422, json: { error: { code: 'insufficient_funds' } } });
    expect(await balanceOf(app, a)).toBe(10_000n);
    expect(await balanceOf(app, b)).toBe(0n);
  });
});
