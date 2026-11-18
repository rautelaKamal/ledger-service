// Step 7d: the owner-scoped reads the web app is built on.
//
// The rule is the one the writes follow since step 7a: an account or top-up
// that is not the caller's answers EXACTLY like one that does not exist (404,
// same body), so a caller probing ids learns nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import { encodeCursor } from '../src/http/reads.js';
import { TEST_CLIENT, createAccount, fundAccount } from './helpers.js';
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

async function get(path: string, clientId: string | null = TEST_CLIENT): Promise<{ status: number; json: any }> {
  const res = await fetch(`${server.url}${path}`, { headers: clientId === null ? {} : { 'x-client-id': clientId } });
  return { status: res.status, json: await res.json() };
}

async function transfer(from: string, to: string, paise: number, clientId = TEST_CLIENT, note?: string): Promise<string> {
  const r = await postTransfer(server.url, {
    key: `reads-${randomUUID()}`,
    clientId,
    body: { fromAccountId: from, toAccountId: to, amountPaise: String(paise), ...(note ? { note } : {}) },
  });
  expect(r.status).toBe(201);
  return (r.json as { transactionId: string }).transactionId;
}

async function requestTopup(accountId: string, paise: number, clientId = TEST_CLIENT): Promise<string> {
  const res = await fetch(`${server.url}/topups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': clientId, 'idempotency-key': `reads-${randomUUID()}` },
    body: JSON.stringify({ accountId, amountPaise: String(paise) }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { topupId: string }).topupId;
}

describe('GET /accounts', () => {
  test('1. lists only the caller\'s accounts; a pending top-up is reported apart and is not in the balance', async () => {
    const mine = await createAccount(app, 'user', 'INR', 'reads: my savings', 'acc-owner');
    await createAccount(app, 'user', 'INR', 'reads: theirs', 'acc-other');
    await fundAccount(owner, mine, 50_000n);
    await requestTopup(mine, 2_500, 'acc-owner');

    const { status, json } = await get('/accounts', 'acc-owner');
    expect(status).toBe(200);
    expect(json.accounts).toEqual([
      expect.objectContaining({ id: mine, name: 'reads: my savings', balancePaise: '50000', pendingTopups: 1, pendingTopupsPaise: '2500' }),
    ]);
    expect((await get('/accounts', 'nobody-at-all')).json).toEqual({ accounts: [] });
  });

  test('2. without X-Client-Id: 401, and no data', async () => {
    const { status, json } = await get('/accounts', null);
    expect(status).toBe(401);
    expect(json.error.code).toBe('missing_client_id');
  });
});

describe('GET /accounts/:id/transactions (the passbook)', () => {
  test('3. another client\'s account answers byte-for-byte like a missing one', async () => {
    const theirs = await createAccount(app, 'user', 'INR', 'theirs', OTHER);
    const ghost = randomUUID();
    const refused = await get(`/accounts/${theirs}/transactions`);
    const missing = await get(`/accounts/${ghost}/transactions`);
    expect(refused).toEqual({ status: 404, json: { error: { code: 'account_not_found', message: `account ${theirs} does not exist` } } });
    expect(missing).toEqual({ status: 404, json: { error: { code: 'account_not_found', message: `account ${ghost} does not exist` } } });
    // Not even a malformed id gets a different answer.
    expect((await get('/accounts/not-a-uuid/transactions')).json).toEqual({
      error: { code: 'account_not_found', message: 'account not-a-uuid does not exist' },
    });
  });

  test('4. newest first, signed amounts, a running balance on posted rows, the counterparty by name', async () => {
    const a = await createAccount(app, 'user', 'INR', 'Asha, Savings');
    const b = await createAccount(app, 'user', 'INR', 'Asha, Current');
    const shop = await createAccount(app, 'user', 'INR', 'Corner shop', OTHER);
    await fundAccount(owner, a, 10_000n);
    const t1 = await transfer(a, b, 3_000, TEST_CLIENT, 'to current');
    const t2 = await transfer(a, shop, 1_250);

    const { json } = await get(`/accounts/${a}/transactions`);
    const [newest, middle, oldest] = json.transactions;
    expect(newest).toMatchObject({ id: t2, kind: 'transfer', status: 'posted', amountPaise: '-1250', balanceAfterPaise: '5750', counterparty: { name: 'Corner shop', isMine: false } });
    expect(middle).toMatchObject({ id: t1, amountPaise: '-3000', balanceAfterPaise: '7000', note: 'to current', counterparty: { name: 'Asha, Current', isMine: true } });
    // fundAccount's top-up: its other side is the bank settlement account, shown as no counterparty.
    expect(oldest).toMatchObject({ kind: 'topup', amountPaise: '10000', balanceAfterPaise: '10000', counterparty: null });
    expect(json.nextCursor).toBeNull();
    // The receiving side sees the same transfer as money in.
    expect((await get(`/accounts/${b}/transactions`)).json.transactions[0]).toMatchObject({ id: t1, amountPaise: '3000', balanceAfterPaise: '3000' });
  });

  test('5. pending and failed top-ups are listed but carry no balance; the balance ignores them', async () => {
    const acct = await createAccount(app, 'user', 'INR', 'with top-ups');
    await fundAccount(owner, acct, 1_000n);
    const pending = await requestTopup(acct, 700);
    const failed = await requestTopup(acct, 900);
    await owner.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [failed]);

    const rows = (await get(`/accounts/${acct}/transactions`)).json.transactions as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.id === pending)).toMatchObject({ status: 'pending', amountPaise: '700', balanceAfterPaise: null });
    expect(rows.find((r) => r.id === failed)).toMatchObject({ status: 'failed', amountPaise: '900', balanceAfterPaise: null });
    expect(rows.find((r) => r.status === 'posted')).toMatchObject({ balanceAfterPaise: '1000' });
  });

  test('6. cursor pagination walks every row exactly once, in order', async () => {
    const a = await createAccount(app, 'user', 'INR', 'paged');
    const b = await createAccount(app, 'user', 'INR', 'paged sink');
    await fundAccount(owner, a, 100_000n);
    for (let i = 1; i <= 7; i++) await transfer(a, b, i * 100);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { json }: { json: any } = await get(`/accounts/${a}/transactions?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...json.transactions.map((t: { id: string }) => t.id));
      cursor = json.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3); // 8 rows (7 transfers + the funding) in pages of 3
    expect(new Set(seen).size).toBe(8);
    const all = (await get(`/accounts/${a}/transactions?limit=100`)).json.transactions.map((t: { id: string }) => t.id);
    expect(seen).toEqual(all);
  });

  test('7. a cursor we did not produce: 400; a cursor cannot reach into another account', async () => {
    const a = await createAccount(app, 'user', 'INR', 'cursor');
    expect((await get(`/accounts/${a}/transactions?cursor=garbage`)).status).toBe(400);
    // A well-formed cursor only positions the page; the account filter still applies.
    const theirs = await createAccount(app, 'user', 'INR', 'their busy account', OTHER);
    await fundAccount(owner, theirs, 5_000n);
    const far = encodeCursor('2999-01-01 00:00:00+00', randomUUID());
    expect((await get(`/accounts/${a}/transactions?cursor=${far}`)).json).toEqual({ transactions: [], nextCursor: null });
  });
});

describe('GET /accounts/:id/balance-history', () => {
  test('8. one closing balance per day; today\'s equals the balance; not yours: 404', async () => {
    const a = await createAccount(app, 'user', 'INR', 'charted');
    await fundAccount(owner, a, 4_200n, 3); // created 3 days ago (back-dating is only possible at insert)
    await fundAccount(owner, a, 800n); // today
    const { status, json } = await get(`/accounts/${a}/balance-history?days=30`);
    expect(status).toBe(200);
    expect(json.days).toHaveLength(30);
    const last5 = json.days.slice(-5).map((d: { balancePaise: string }) => d.balancePaise);
    expect(last5).toEqual(['0', '4200', '4200', '4200', '5000']); // each entry on its own day; today = the balance

    const theirs = await createAccount(app, 'user', 'INR', 'theirs', OTHER);
    expect((await get(`/accounts/${theirs}/balance-history`)).status).toBe(404);
  });
});

describe('GET /topups/:id', () => {
  test('9. the owner sees the timeline; anyone else gets the same 404 as a missing top-up', async () => {
    const acct = await createAccount(app, 'user', 'INR', 'topped up');
    const topupId = await requestTopup(acct, 5_000);
    await owner.query(
      `INSERT INTO webhook_events (provider_event_id, event_type, provider_payment_id, raw_body, result, topup_transaction_id)
       VALUES ('evt_reads_1', 'payment.succeeded', 'pay_reads_1', '{}', 'posted', $1)`,
      [topupId],
    );

    const mine = await get(`/topups/${topupId}`);
    expect(mine.status).toBe(200);
    expect(mine.json).toMatchObject({
      topupId,
      accountId: acct,
      amountPaise: '5000',
      status: 'pending',
      providerPaymentId: null, // no worker in this test: the payment was never requested
      webhooks: [{ eventId: 'evt_reads_1', type: 'payment.succeeded', result: 'posted' }],
    });

    const ghost = randomUUID();
    expect(await get(`/topups/${topupId}`, OTHER)).toEqual({ status: 404, json: { error: { code: 'topup_not_found', message: `top-up ${topupId} does not exist` } } });
    expect(await get(`/topups/${ghost}`)).toEqual({ status: 404, json: { error: { code: 'topup_not_found', message: `top-up ${ghost} does not exist` } } });
  });
});
