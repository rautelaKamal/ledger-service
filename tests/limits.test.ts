// Per-request amount limits (src/limits.ts): one top-up at most ₹1,00,000.00,
// one transfer at most ₹2,00,000.00. Above them the API answers 400
// amount_over_limit and stores nothing: no transaction, no top-up, and the
// idempotency key stays free.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import { TOPUP_MAX_PAISE, TRANSFER_MAX_PAISE, rupees } from '../src/limits.js';
import { TEST_CLIENT, balanceOf, createAccount, expectLedgerReconciles, fundAccount } from './helpers.js';
import { postTransfer, startTestServer, type TestServer } from './http.js';
import { resetLedger } from './reset.js';

let app: Pool; // ledger_app
let owner: Pool; // ledger_owner
let server: TestServer;

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: 5 });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  await resetLedger(owner);
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
  await Promise.all([app.end(), owner.end()]);
});

async function postTopup(key: string, accountId: string, amountPaise: bigint): Promise<{ status: number; json: any }> {
  const res = await fetch(`${server.url}/topups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': TEST_CLIENT, 'idempotency-key': key },
    body: JSON.stringify({ accountId, amountPaise: amountPaise.toString() }),
  });
  return { status: res.status, json: await res.json() };
}

const storedUnder = async (key: string) =>
  (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1', [key])).rows[0]!.n;

describe('amount limits', () => {
  test('1. GET /limits publishes the two limits, in paise, as strings', async () => {
    const res = await fetch(`${server.url}/limits`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topupMaxPaise: '10000000', transferMaxPaise: '20000000' });
    expect(rupees(TOPUP_MAX_PAISE)).toBe('₹1,00,000.00');
    expect(rupees(TRANSFER_MAX_PAISE)).toBe('₹2,00,000.00');
  });

  test('2. a transfer of exactly ₹2,00,000.00 goes through; one paisa more is a 400 that stores nothing', async () => {
    const from = await createAccount(app, 'user');
    const to = await createAccount(app, 'user');
    await fundAccount(owner, from, 5_00_000_00n);

    const atLimit = await postTransfer(server.url, { key: `lim-${randomUUID()}`, clientId: TEST_CLIENT, body: { fromAccountId: from, toAccountId: to, amountPaise: TRANSFER_MAX_PAISE.toString() } });
    expect(atLimit.status).toBe(201);

    const key = `lim-${randomUUID()}`;
    const over = await postTransfer(server.url, { key, clientId: TEST_CLIENT, body: { fromAccountId: from, toAccountId: to, amountPaise: (TRANSFER_MAX_PAISE + 1n).toString() } });
    expect(over.status).toBe(400);
    expect(over.json).toEqual({
      error: {
        code: 'amount_over_limit',
        message: 'one transfer can be at most ₹2,00,000.00; this one is ₹2,00,000.01',
        details: { maxPaise: '20000000' },
      },
    });
    expect(await storedUnder(key)).toBe(0);
    expect(await balanceOf(app, to)).toBe(TRANSFER_MAX_PAISE); // only the first one moved

    // The key was not used up: the same key with an amount within the limit works.
    const retry = await postTransfer(server.url, { key, clientId: TEST_CLIENT, body: { fromAccountId: from, toAccountId: to, amountPaise: '100' } });
    expect(retry.status).toBe(201);
    await expectLedgerReconciles(app);
  });

  test('3. a top-up of exactly ₹1,00,000.00 is accepted; one paisa more, or ₹10,00,00,00,000, is a 400 that stores nothing', async () => {
    const account = await createAccount(app, 'user');
    expect((await postTopup(`lim-${randomUUID()}`, account, TOPUP_MAX_PAISE)).status).toBe(202);

    for (const amount of [TOPUP_MAX_PAISE + 1n, 10_00_00_00_000_00n]) {
      const key = `lim-${randomUUID()}`;
      const over = await postTopup(key, account, amount);
      expect(over.status).toBe(400);
      expect(over.json.error.code).toBe('amount_over_limit');
      expect(over.json.error.message).toBe(`one top-up can be at most ₹1,00,000.00; this one is ${rupees(amount)}`);
      expect(await storedUnder(key)).toBe(0);
    }
    const topups = await owner.query<{ amount_paise: string }>('SELECT amount_paise::text FROM topups WHERE account_id = $1', [account]);
    expect(topups.rows).toEqual([{ amount_paise: TOPUP_MAX_PAISE.toString() }]);
  });
});
