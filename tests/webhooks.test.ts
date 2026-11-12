// Top-ups and provider webhooks, over real HTTP against the real app and
// database, with the mock provider running in-process.
//
// Setup: beforeAll TRUNCATEs the ledger (and re-seeds bank_settlement INR),
// afterEach checks every account reconciles. Tests run as ledger_app except
// where noted.

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { MockProvider, type WebhookEvent } from '../mock-provider/provider.js';
import { signWebhook } from '../mock-provider/signature.js';
import { createPool, type Pool } from '../src/db.js';
import { transfer } from '../src/ledger/transfer.js';
import { HttpProviderClient, type ProviderClient } from '../src/provider/client.js';
import { PG, balanceOf, createAccount, expectLedgerReconciles, fundAccount } from './helpers.js';
import { TEST_WEBHOOK_SECRET, startTestServer, type HttpResult, type TestServer } from './http.js';
import { resetLedger } from './reset.js';

let app: Pool; // ledger_app
let owner: Pool; // ledger_owner
let server: TestServer;
let provider: MockProvider;
/** Lets one test swap the provider the app talks to (for the "provider hangs" test). */
let currentProvider: ProviderClient;
/** Lets one test make the next webhook commit fail. */
let failNextCommit: Error | null = null;

const CLIENT = 'topup-client';
const newKey = (): string => `key-${randomUUID()}`;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: 20 });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  await resetLedger(owner);

  provider = new MockProvider({ secret: TEST_WEBHOOK_SECRET, webhookUrl: 'set-after-listen', retry: { attempts: 4, baseDelayMs: 50 } });
  currentProvider = { createPayment: async (input) => ({ paymentId: provider.createPayment(input).id }) };

  server = await startTestServer(app, {
    provider: { createPayment: (input) => currentProvider.createPayment(input) },
    testHooks: {
      beforeWebhookCommit: async () => {
        if (failNextCommit) {
          const err = failNextCommit;
          failNextCommit = null;
          throw err;
        }
      },
    },
  });
  provider.webhookUrl = `${server.url}/webhooks/provider`;
});

afterEach(async () => {
  failNextCommit = null;
  await expectLedgerReconciles(owner);
});

afterAll(async () => {
  await server.close();
  await app.end();
  await owner.end();
});

// ───────────── helpers ─────────────

async function postTopup(accountId: string, amountPaise: string, key = newKey()): Promise<HttpResult> {
  const res = await fetch(`${server.url}/topups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': CLIENT, 'idempotency-key': key },
    body: JSON.stringify({ accountId, amountPaise }),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

/** Start a top-up and return everything a test needs to confirm it. */
async function startTopup(accountId: string, amountPaise = '25000'): Promise<{ topupId: string; paymentId: string }> {
  const res = await postTopup(accountId, amountPaise);
  expect(res.status).toBe(202);
  const { topupId } = res.json as { topupId: string };
  const { rows } = await owner.query<{ provider_payment_id: string }>(
    'SELECT provider_payment_id FROM topups WHERE transaction_id = $1',
    [topupId],
  );
  return { topupId, paymentId: rows[0]!.provider_payment_id };
}

async function topupState(topupId: string): Promise<{ status: string; entries: number; posted_at: Date | null; created_at: Date }> {
  const { rows } = await owner.query<{ status: string; entries: number; posted_at: Date | null; created_at: Date }>(
    `SELECT status, posted_at, created_at, (SELECT count(*)::int FROM entries WHERE transaction_id = $1) AS entries
       FROM transactions WHERE id = $1`,
    [topupId],
  );
  return rows[0]!;
}

async function eventRows(paymentId: string): Promise<{ provider_event_id: string; result: string; raw_body: string }[]> {
  const { rows } = await owner.query<{ provider_event_id: string; result: string; raw_body: string }>(
    'SELECT provider_event_id, result, raw_body FROM webhook_events WHERE provider_payment_id = $1 ORDER BY received_at',
    [paymentId],
  );
  return rows;
}

async function eventCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_events');
  return rows[0]!.n;
}

async function settlementBalance(): Promise<bigint> {
  const { rows } = await owner.query<{ balance_paise: bigint }>(
    `SELECT balance_paise FROM accounts WHERE kind = 'system' AND name = 'bank_settlement' AND currency = 'INR'`,
  );
  return rows[0]!.balance_paise;
}

/** Send arbitrary bytes with an arbitrary signature header (for forgeries). */
async function sendRaw(rawBody: string, header: string | null): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (header !== null) headers['provider-signature'] = header;
  const res = await fetch(`${server.url}/webhooks/provider`, { method: 'POST', headers, body: rawBody });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

// ───────────── tests ─────────────

describe('top-ups and provider webhooks', () => {
  test('1. a top-up starts pending with no entries and no balance change', async () => {
    const account = await createAccount(app, 'user');
    const bankBefore = await settlementBalance();

    const res = await postTopup(account, '25000');

    expect(res.status).toBe(202);
    expect(res.json).toEqual({ topupId: expect.any(String), status: 'pending' });
    const { topupId } = res.json as { topupId: string };
    expect(await topupState(topupId)).toMatchObject({ status: 'pending', entries: 0, posted_at: null });
    expect(await balanceOf(app, account)).toBe(0n);
    expect(await settlementBalance()).toBe(bankBefore);

    // The provider knows about it, with our id as the reference.
    const { rows } = await owner.query<{ provider_payment_id: string }>(
      'SELECT provider_payment_id FROM topups WHERE transaction_id = $1',
      [topupId],
    );
    expect(provider.getPayment(rows[0]!.provider_payment_id)).toMatchObject({ amountPaise: '25000', currency: 'INR', reference: topupId });
  });

  test('2. a valid payment.succeeded webhook posts the top-up: entries, balances, status', async () => {
    const account = await createAccount(app, 'user');
    const bankBefore = await settlementBalance();
    const { topupId, paymentId } = await startTopup(account, '25000');

    const [report] = await provider.settle(paymentId, 'succeeded');

    expect(report!.attempts).toEqual([{ status: 200, body: { received: true, result: 'posted' } }]);
    const state = await topupState(topupId);
    expect(state).toMatchObject({ status: 'posted', entries: 2 });
    expect(state.posted_at!.getTime()).toBeGreaterThan(state.created_at.getTime()); // posted in a LATER transaction
    expect(await balanceOf(app, account)).toBe(25_000n);
    expect(await settlementBalance()).toBe(bankBefore - 25_000n);
    expect(await eventRows(paymentId)).toMatchObject([{ result: 'posted' }]);
  });

  test('3. the same webhook delivered 5 times credits once', async () => {
    const account = await createAccount(app, 'user');
    const { topupId, paymentId } = await startTopup(account);

    const reports = await provider.settle(paymentId, 'succeeded', { times: 5 });

    expect(reports.map((r) => r.attempts[0]!.body)).toEqual([
      { received: true, result: 'posted' },
      { received: true, duplicate: true },
      { received: true, duplicate: true },
      { received: true, duplicate: true },
      { received: true, duplicate: true },
    ]);
    expect(await topupState(topupId)).toMatchObject({ status: 'posted', entries: 2 });
    expect(await balanceOf(app, account)).toBe(25_000n);
    expect(await eventRows(paymentId)).toHaveLength(1);
  });

  test('4. 10 identical webhooks delivered concurrently credit once', async () => {
    const account = await createAccount(app, 'user');
    const { topupId, paymentId } = await startTopup(account);
    const event = provider.buildEvent(paymentId, 'succeeded');

    const results = await Promise.all(Array.from({ length: 10 }, () => provider.deliver(event)));

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    const posted = results.filter((r) => (r.body as { result?: string }).result === 'posted');
    const duplicates = results.filter((r) => (r.body as { duplicate?: boolean }).duplicate === true);
    expect(posted).toHaveLength(1);
    expect(duplicates).toHaveLength(9);
    expect(await topupState(topupId)).toMatchObject({ status: 'posted', entries: 2 });
    expect(await balanceOf(app, account)).toBe(25_000n);
    expect(await eventRows(paymentId)).toHaveLength(1);
  });

  test('5. forged, tampered, unsigned, stale and future-dated webhooks are rejected with 401 and nothing is stored', async () => {
    const account = await createAccount(app, 'user');
    const { topupId, paymentId } = await startTopup(account);
    const event = provider.buildEvent(paymentId, 'succeeded');
    const rawBody = JSON.stringify(event);
    const before = await eventCount();
    const t = nowSeconds();

    const cases: [string, () => Promise<HttpResult>][] = [
      ['wrong secret', () => sendRaw(rawBody, signWebhook('not-the-secret', rawBody, t))],
      ['tampered body', () => sendRaw(rawBody.replace('"25000"', '"99999"'), signWebhook(TEST_WEBHOOK_SECRET, rawBody, t))],
      ['missing header', () => sendRaw(rawBody, null)],
      ['malformed header', () => sendRaw(rawBody, 'v1=abc')],
      ['stale timestamp (6 min)', () => sendRaw(rawBody, signWebhook(TEST_WEBHOOK_SECRET, rawBody, t - 6 * 60))],
      ['future timestamp (10 min)', () => sendRaw(rawBody, signWebhook(TEST_WEBHOOK_SECRET, rawBody, t + 10 * 60))],
    ];
    for (const [name, send] of cases) {
      const res = await send();
      expect(res.status, name).toBe(401);
      expect(res.json, name).toMatchObject({ error: { code: 'invalid_signature' } });
    }

    expect(await eventCount()).toBe(before);
    expect(await topupState(topupId)).toMatchObject({ status: 'pending', entries: 0 });
    expect(await balanceOf(app, account)).toBe(0n);

    // Small clock skew into the future is tolerated.
    const skewed = await sendRaw(rawBody, signWebhook(TEST_WEBHOOK_SECRET, rawBody, t + 10));
    expect(skewed.status).toBe(200);
  });

  test('6. payment.failed marks the top-up failed: no entries, no balance change', async () => {
    const account = await createAccount(app, 'user');
    const bankBefore = await settlementBalance();
    const { topupId, paymentId } = await startTopup(account);

    const [report] = await provider.settle(paymentId, 'failed');

    expect(report!.attempts[0]!.body).toEqual({ received: true, result: 'failed' });
    expect(await topupState(topupId)).toMatchObject({ status: 'failed', entries: 0, posted_at: null });
    expect(await balanceOf(app, account)).toBe(0n);
    expect(await settlementBalance()).toBe(bankBefore);
  });

  test('7. out-of-order events are ignored: succeeded after failed, and failed after succeeded', async () => {
    const account = await createAccount(app, 'user');

    // failed, then succeeded (late success for a payment we already gave up on)
    const first = await startTopup(account);
    await provider.settle(first.paymentId, 'failed');
    const [lateSuccess] = await provider.settle(first.paymentId, 'succeeded');
    expect(lateSuccess!.attempts[0]!.body).toMatchObject({ received: true, result: 'ignored_already_final', detail: 'top-up is already failed' });
    expect(await topupState(first.topupId)).toMatchObject({ status: 'failed', entries: 0 });
    expect(await balanceOf(app, account)).toBe(0n);

    // succeeded, then failed (a bogus failure after the money is in)
    const second = await startTopup(account);
    await provider.settle(second.paymentId, 'succeeded');
    const [lateFailure] = await provider.settle(second.paymentId, 'failed');
    expect(lateFailure!.attempts[0]!.body).toMatchObject({ received: true, result: 'ignored_already_final', detail: 'top-up is already posted' });
    expect(await topupState(second.topupId)).toMatchObject({ status: 'posted', entries: 2 });
    expect(await balanceOf(app, account)).toBe(25_000n);

    expect(await eventRows(first.paymentId)).toMatchObject([{ result: 'failed' }, { result: 'ignored_already_final' }]);
    expect(await eventRows(second.paymentId)).toMatchObject([{ result: 'posted' }, { result: 'ignored_already_final' }]);
  });

  test('8. an amount or currency mismatch is stored as an anomaly and nothing is credited', async () => {
    const account = await createAccount(app, 'user');
    const { topupId, paymentId } = await startTopup(account, '25000');

    const wrongAmount = await provider.deliver(provider.buildEvent(paymentId, 'succeeded', { amountPaise: '25001' }));
    expect(wrongAmount).toMatchObject({ status: 200, body: { result: 'anomaly_amount_mismatch', detail: 'expected 25000 INR, webhook says 25001 INR' } });
    const wrongCurrency = await provider.deliver(provider.buildEvent(paymentId, 'succeeded', { currency: 'USD' }));
    expect(wrongCurrency).toMatchObject({ status: 200, body: { result: 'anomaly_amount_mismatch' } });

    expect(await topupState(topupId)).toMatchObject({ status: 'pending', entries: 0 }); // left for a human
    expect(await balanceOf(app, account)).toBe(0n);
    expect(await eventRows(paymentId)).toMatchObject([{ result: 'anomaly_amount_mismatch' }, { result: 'anomaly_amount_mismatch' }]);

    // A later, correct confirmation still works.
    const [ok] = await provider.settle(paymentId, 'succeeded');
    expect(ok!.attempts[0]!.body).toEqual({ received: true, result: 'posted' });
    expect(await balanceOf(app, account)).toBe(25_000n);
  });

  test('9. an event for an unknown paymentId is stored as unmatched and acknowledged with 200', async () => {
    const ghost = provider.createPayment({ amountPaise: '100', currency: 'INR', reference: 'never-recorded' });
    const event = provider.buildEvent(ghost.id, 'succeeded');

    const res = await provider.deliver(event);

    expect(res).toMatchObject({ status: 200, body: { received: true, result: 'unmatched' } });
    const rows = await eventRows(ghost.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.raw_body)).toEqual(event); // the exact bytes are kept for investigation
  });

  test('10. a failure during processing leaves nothing half-written, and the provider retry succeeds', async () => {
    const account = await createAccount(app, 'user');
    const { topupId, paymentId } = await startTopup(account);
    const event = provider.buildEvent(paymentId, 'succeeded');
    const before = await eventCount();

    failNextCommit = new Error('simulated crash before COMMIT');
    const crashed = await provider.deliver(event);
    expect(crashed.status).toBe(500);
    expect(await eventCount()).toBe(before);
    expect(await topupState(topupId)).toMatchObject({ status: 'pending', entries: 0 });
    expect(await balanceOf(app, account)).toBe(0n);

    // The provider's at-least-once delivery: one more crash, then it gets through.
    failNextCommit = new Error('simulated crash before COMMIT, again');
    const report = await provider.deliverWithRetry(event);
    expect(report.attempts.map((a) => a.status)).toEqual([500, 200]);
    expect(report.delivered).toBe(true);
    expect(await topupState(topupId)).toMatchObject({ status: 'posted', entries: 2 });
    expect(await balanceOf(app, account)).toBe(25_000n);
    expect(await eventRows(paymentId)).toHaveLength(1);
  });

  test('11. after all of the above, every account reconciles', async () => {
    await expectLedgerReconciles(owner);
    const { rows } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_events');
    expect(rows[0]!.n).toBeGreaterThan(5); // the ledger has been busy
  });

  test('12. a provider that hangs longer than the timeout gives 502, stores nothing, and the retry works', async () => {
    const account = await createAccount(app, 'user');
    const key = newKey();
    const before = await owner.query<{ tx: number; topups: number; keys: number }>(
      `SELECT (SELECT count(*)::int FROM transactions) AS tx, (SELECT count(*)::int FROM topups) AS topups,
              (SELECT count(*)::int FROM idempotency_keys) AS keys`,
    );

    // A provider that accepts the connection and never answers.
    const hanging: Server = createServer(() => {});
    await new Promise<void>((r) => hanging.listen(0, r));
    const port = (hanging.address() as { port: number }).port;
    const normal = currentProvider;
    currentProvider = new HttpProviderClient(`http://127.0.0.1:${port}`, 500); // 500 ms instead of the 3 s default
    try {
      const started = Date.now();
      const res = await postTopup(account, '25000', key);
      expect(Date.now() - started).toBeGreaterThanOrEqual(450);
      expect(res.status).toBe(502);
      expect(res.json).toMatchObject({ error: { code: 'provider_unavailable' } });
    } finally {
      currentProvider = normal;
      hanging.closeAllConnections();
      await new Promise<void>((r) => hanging.close(() => r()));
    }

    const after = await owner.query('SELECT (SELECT count(*)::int FROM transactions) AS tx, (SELECT count(*)::int FROM topups) AS topups, (SELECT count(*)::int FROM idempotency_keys) AS keys');
    expect(after.rows[0]).toEqual(before.rows[0]); // nothing stored

    const retry = await postTopup(account, '25000', key); // same key, provider back
    expect(retry.status).toBe(202);
    expect(retry.headers.get('idempotent-replayed')).toBeNull();
  });

  test('13. top-ups are refused for unknown, system and unsupported-currency accounts, storing nothing', async () => {
    const system = await createAccount(app, 'system');
    const usd = await createAccount(app, 'user', 'USD');
    const before = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM transactions');

    expect(await postTopup(randomUUID(), '100')).toMatchObject({ status: 404, json: { error: { code: 'account_not_found' } } });
    expect(await postTopup(system, '100')).toMatchObject({ status: 422, json: { error: { code: 'not_a_user_account' } } });
    expect(await postTopup(usd, '100')).toMatchObject({ status: 422, json: { error: { code: 'unsupported_currency' } } });

    const after = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM transactions');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  test('14. a genuine webhook that is not JSON or has no event id gets 400 and is not stored', async () => {
    const before = await eventCount();
    const t = nowSeconds();

    const notJson = '{"id": "evt_broken"';
    expect((await sendRaw(notJson, signWebhook(TEST_WEBHOOK_SECRET, notJson, t))).status).toBe(400);
    const noId = JSON.stringify({ type: 'payment.succeeded', data: { paymentId: 'pay_x' } });
    expect((await sendRaw(noId, signWebhook(TEST_WEBHOOK_SECRET, noId, t))).status).toBe(400);

    expect(await eventCount()).toBe(before);
  });

  test(
    '15. concurrent transfers and top-up webhooks on the same account finish without deadlocks and reconcile',
    async () => {
      const a = await createAccount(app, 'user');
      const b = await createAccount(app, 'user');
      await fundAccount(owner, a, 10_000n);
      await fundAccount(owner, b, 10_000n);

      // 10 top-ups of ₹10 onto A, each with its own payment and event.
      const events: WebhookEvent[] = [];
      for (let i = 0; i < 10; i++) {
        const { paymentId } = await startTopup(a, '1000');
        events.push(provider.buildEvent(paymentId, 'succeeded'));
      }

      // Fire everything at once: webhooks (lock A + bank), A->B and B->A transfers (lock A + B).
      const jobs: Promise<unknown>[] = [];
      for (const event of events) jobs.push(provider.deliver(event));
      for (let i = 0; i < 20; i++) {
        jobs.push(transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: 100n }));
        jobs.push(transfer(app, { fromAccountId: b, toAccountId: a, amountPaise: 100n }));
      }
      const results = await Promise.allSettled(jobs);

      const deadlocks = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === PG.DEADLOCK_DETECTED);
      const failures = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
      expect(deadlocks).toHaveLength(0);
      expect(failures).toEqual([]);
      const webhookStatuses = results.slice(0, 10).map((r) => (r as PromiseFulfilledResult<{ status: number }>).value.status);
      expect(webhookStatuses).toEqual(Array(10).fill(200));

      expect(await balanceOf(app, a)).toBe(10_000n + 10n * 1_000n); // +10 top-ups, transfers net to zero
      expect(await balanceOf(app, b)).toBe(10_000n);
      await expectLedgerReconciles(owner);
    },
    30_000,
  );
});
