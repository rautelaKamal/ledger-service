// Step 7a: account ownership. A user account belongs to exactly one client
// (owner_client_id); only that client may spend from it or top it up.
//
// "Not yours" answers exactly like "does not exist" (404, same body), so a
// caller probing ids learns nothing. Paying TO any account stays allowed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import { PG, TEST_CLIENT, balanceOf, createAccount, expectLedgerReconciles, fundAccount, withRollback } from './helpers.js';
import { postTransfer, startTestServer, type TestServer } from './http.js';
import { resetLedger } from './reset.js';

let app: Pool; // ledger_app
let owner: Pool; // ledger_owner
let server: TestServer;

const OTHER = 'someone-else';

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

const newKey = (): string => `own-${randomUUID()}`;

async function postTopup(accountId: string, clientId: string, key = newKey()): Promise<{ status: number; json: unknown; headers: Headers }> {
  const res = await fetch(`${server.url}/topups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': clientId, 'idempotency-key': key },
    body: JSON.stringify({ accountId, amountPaise: '1000' }),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

describe('POST /transfers: only the owner may spend from an account', () => {
  test('1. from another client\'s account: 404, the same body as a missing account, stored and replayed, no money moved', async () => {
    const mine = await createAccount(app, 'user', 'INR', 'mine', TEST_CLIENT);
    const theirs = await createAccount(app, 'user', 'INR', 'theirs', OTHER);
    await fundAccount(owner, theirs, 10_000n);
    const key = newKey();
    const body = { fromAccountId: theirs, toAccountId: mine, amountPaise: '500' };

    const refused = await postTransfer(server.url, { key, clientId: TEST_CLIENT, body });
    expect(refused.status).toBe(404);
    expect(refused.json).toEqual({ error: { code: 'account_not_found', message: `account ${theirs} does not exist` } });

    // Byte-for-byte what a truly missing account gets.
    const ghost = randomUUID();
    const missing = await postTransfer(server.url, { key: newKey(), clientId: TEST_CLIENT, body: { ...body, fromAccountId: ghost } });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: { code: 'account_not_found', message: `account ${ghost} does not exist` } });

    // A business answer: the retry replays it instead of re-deciding.
    const retry = await postTransfer(server.url, { key, clientId: TEST_CLIENT, body });
    expect(retry.status).toBe(404);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');

    expect(await balanceOf(app, theirs)).toBe(10_000n);
    expect(await balanceOf(app, mine)).toBe(0n);
    // The owner can, of course.
    expect((await postTransfer(server.url, { key: newKey(), clientId: OTHER, body })).status).toBe(201);
    expect(await balanceOf(app, mine)).toBe(500n);
  });

  test('2. a system account has no owner: nobody can spend from it through the API', async () => {
    const mine = await createAccount(app, 'user', 'INR', 'mine', TEST_CLIENT);
    const { rows } = await owner.query<{ id: string }>(`SELECT id FROM accounts WHERE kind = 'system' AND name = 'bank_settlement' AND currency = 'INR'`);
    const bank = rows[0]!.id;
    const res = await postTransfer(server.url, { key: newKey(), clientId: TEST_CLIENT, body: { fromAccountId: bank, toAccountId: mine, amountPaise: '1' } });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: { code: 'account_not_found', message: `account ${bank} does not exist` } });
  });

  test('3. paying TO any account is allowed: another client\'s, or a system account', async () => {
    const mine = await createAccount(app, 'user', 'INR', 'mine', TEST_CLIENT);
    const theirs = await createAccount(app, 'user', 'INR', 'theirs', OTHER);
    const fees = await createAccount(app, 'system', 'INR', 'fees');
    await fundAccount(owner, mine, 10_000n);

    expect((await postTransfer(server.url, { key: newKey(), clientId: TEST_CLIENT, body: { fromAccountId: mine, toAccountId: theirs, amountPaise: '300' } })).status).toBe(201);
    expect((await postTransfer(server.url, { key: newKey(), clientId: TEST_CLIENT, body: { fromAccountId: mine, toAccountId: fees, amountPaise: '200' } })).status).toBe(201);
    expect(await balanceOf(app, mine)).toBe(9_500n);
    expect(await balanceOf(app, theirs)).toBe(300n);
    expect(await balanceOf(app, fees)).toBe(200n);
    await expectLedgerReconciles(owner);
  });
});

describe('POST /topups: only the owner may top an account up', () => {
  test('4. another client\'s account, and a system account: 404 like a missing one; the owner gets 202', async () => {
    const theirs = await createAccount(app, 'user', 'INR', 'theirs', OTHER);
    const refused = await postTopup(theirs, TEST_CLIENT);
    expect(refused.status).toBe(404);
    expect(refused.json).toEqual({ error: { code: 'account_not_found', message: `account ${theirs} does not exist` } });

    const { rows } = await owner.query<{ id: string }>(`SELECT id FROM accounts WHERE kind = 'system' AND name = 'bank_settlement' AND currency = 'INR'`);
    const system = await postTopup(rows[0]!.id, TEST_CLIENT);
    expect(system.status).toBe(404);

    const ok = await postTopup(theirs, OTHER);
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ status: 'pending' });
  });
});

describe('the database enforces the shape of ownership', () => {
  test('5. a user account must have an owner, a system account must not, and an owner never changes', async () => {
    await withRollback(owner, async (db) => {
      await expect(db.query(`INSERT INTO accounts (name, kind, currency) VALUES ('orphan', 'user', 'INR')`)).rejects.toMatchObject({
        code: PG.CHECK_VIOLATION,
      });
    });
    await withRollback(owner, async (db) => {
      await expect(
        db.query(`INSERT INTO accounts (name, kind, currency, owner_client_id) VALUES ('owned system', 'system', 'INR', 'x')`),
      ).rejects.toMatchObject({ code: PG.CHECK_VIOLATION });
    });
    const mine = await createAccount(app, 'user', 'INR', 'mine', TEST_CLIENT);
    await withRollback(owner, async (db) => {
      await expect(db.query(`UPDATE accounts SET owner_client_id = $2 WHERE id = $1`, [mine, OTHER])).rejects.toMatchObject({
        code: PG.RAISE_EXCEPTION,
      });
    });
    // The API role cannot even try: it has no UPDATE on that column.
    await expect(app.query(`UPDATE accounts SET owner_client_id = $2 WHERE id = $1`, [mine, OTHER])).rejects.toMatchObject({
      code: PG.INSUFFICIENT_PRIVILEGE,
    });
    expect((await app.query<{ owner_client_id: string }>('SELECT owner_client_id FROM accounts WHERE id = $1', [mine])).rows[0]?.owner_client_id).toBe(TEST_CLIENT);
  });
});
