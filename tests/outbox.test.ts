// The transactional outbox and its worker.
//
// Setup: beforeAll TRUNCATEs the ledger (re-seeding bank_settlement), the
// real app runs on a random port, the mock provider and a MemorySink run
// in-process, and the worker is driven with tick(). Test 8 spawns the real
// worker process. afterEach checks every account reconciles.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { MockProvider } from '../mock-provider/provider.js';
import { SinkStore } from '../mock-provider/sink.js';
import { createPool, type Pool } from '../src/db.js';
import { transfer, transferWithClient } from '../src/ledger/transfer.js';
import { HttpProviderClient, type ProviderClient } from '../src/provider/client.js';
import { createHandlers, type Handlers } from '../src/worker/handlers.js';
import { backoffMs, processOneRow, type WorkerOptions } from '../src/worker/outbox.js';
import { Worker } from '../src/worker/run.js';
import { MemorySink, type NotificationSink } from '../src/worker/sinks.js';
import { balanceOf, createAccount, expectLedgerReconciles, fundAccount, withRollback } from './helpers.js';
import { TEST_WEBHOOK_SECRET, startTestServer, type TestServer } from './http.js';
import { resetLedger } from './reset.js';
import { exitWithin, spawnTs } from './spawn.js';

let app: Pool; // ledger_app
let owner: Pool; // ledger_owner
let workerPool: Pool; // ledger_worker
let server: TestServer;
let provider: MockProvider;

const CLIENT = 'outbox-client';

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: 20 });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  workerPool = createPool(process.env.WORKER_DATABASE_URL!, { max: 10 });
  await resetLedger(owner);
  server = await startTestServer(app);
  provider = new MockProvider({ secret: TEST_WEBHOOK_SECRET, webhookUrl: `${server.url}/webhooks/provider`, retry: { attempts: 3, baseDelayMs: 20 } });
});

afterEach(async () => {
  await expectLedgerReconciles(owner);
});

afterAll(async () => {
  await server.close();
  await app.end();
  await owner.end();
  await workerPool.end();
});

// ───────────── helpers ─────────────

const inProcessProvider: ProviderClient = {
  createPayment: async (input) => ({ paymentId: provider.createPayment(input).id }),
};

function makeWorker(opts: { provider?: ProviderClient; sink?: NotificationSink; options?: WorkerOptions } = {}): { worker: Worker; sink: MemorySink; handlers: Handlers } {
  const sink = (opts.sink as MemorySink | undefined) ?? new MemorySink();
  const handlers = createHandlers({ provider: opts.provider ?? inProcessProvider, sink });
  return { worker: new Worker(workerPool, handlers, opts.options ?? {}), sink, handlers };
}

async function postTopup(accountId: string, amountPaise = '25000'): Promise<string> {
  const res = await fetch(`${server.url}/topups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': CLIENT, 'idempotency-key': `key-${randomUUID()}` },
    body: JSON.stringify({ accountId, amountPaise }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { topupId: string }).topupId;
}

interface OutboxRowView {
  id: bigint;
  type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  available_at: Date;
  payload: Record<string, string>;
}

async function outboxRows(where = 'TRUE', params: unknown[] = []): Promise<OutboxRowView[]> {
  const { rows } = await owner.query<OutboxRowView>(
    `SELECT id, type, status, attempts, last_error, available_at, payload FROM outbox WHERE ${where} ORDER BY id`,
    params,
  );
  return rows;
}

async function outboxCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox');
  return rows[0]!.n;
}

async function recordedPaymentId(topupId: string): Promise<string | null> {
  const { rows } = await owner.query<{ provider_payment_id: string | null }>('SELECT provider_payment_id FROM topups WHERE transaction_id = $1', [topupId]);
  return rows[0]!.provider_payment_id;
}

/**
 * Queue N plain events as the API would (ledger_app can only INSERT type + payload).
 * Returns a tag that identifies exactly these rows: `payload->>'tag' = tag`.
 */
async function enqueueEvents(n: number): Promise<string> {
  const tag = `tag-${randomUUID()}`;
  for (let i = 0; i < n; i++) {
    await app.query(`INSERT INTO outbox (type, payload) VALUES ('transfer.posted', $1::jsonb)`, [
      JSON.stringify({ tag, transactionId: randomUUID(), fromAccountId: 'a', toAccountId: 'b', currency: 'INR', amountPaise: '1' }),
    ]);
  }
  return tag;
}
const tagged = (tag: string, extra = 'TRUE'): [string, unknown[]] => [`payload->>'tag' = $1 AND (${extra})`, [tag]];

/**
 * How many database sessions with this application_name are still connected.
 * A process that exits closes its sockets, but the server notices a moment
 * later, so poll for up to 2 s before giving the final answer.
 */
async function sessionsNamed(appName: string): Promise<number> {
  let n = 0;
  for (let i = 0; i < 20; i++) {
    const { rows } = await workerPool.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [appName]);
    n = rows[0]!.n;
    if (n === 0) return 0;
    await new Promise((r) => setTimeout(r, 100));
  }
  return n;
}

/** Drain the outbox with a throwaway worker so the next test starts clean. */
async function drainOutbox(): Promise<void> {
  const { worker } = makeWorker();
  await worker.tick(1000);
}

// ───────────── tests ─────────────

describe('transactional outbox and worker', () => {
  test('1. a transfer writes its outbox row in the same transaction; a rolled-back transfer writes none', async () => {
    const a = await createAccount(app, 'user');
    const b = await createAccount(app, 'user');
    await fundAccount(owner, a, 10_000n);

    const { transactionId } = await transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: 2_500n });
    const rows = await outboxRows(`type = 'transfer.posted' AND payload->>'transactionId' = $1`, [transactionId]);
    expect(rows).toMatchObject([{ status: 'pending', payload: { transactionId, fromAccountId: a, toAccountId: b, currency: 'INR', amountPaise: '2500' } }]);

    // Same transaction: a transfer that is rolled back leaves no outbox row ...
    const before = await outboxCount();
    await withRollback(app, async (client) => {
      await transferWithClient(client, { fromAccountId: a, toAccountId: b, amountPaise: 100n });
    });
    expect(await outboxCount()).toBe(before);
    // ... and neither does one that fails (insufficient funds).
    await expect(transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: 1_000_000n })).rejects.toThrow();
    expect(await outboxCount()).toBe(before);
  });

  test('2. POST /topups returns 202 without calling the provider; the worker then calls it with the top-up id as Idempotency-Key', async () => {
    const account = await createAccount(app, 'user');
    const topupId = await postTopup(account);

    expect(provider.paymentsForReference(topupId)).toHaveLength(0);
    expect(await recordedPaymentId(topupId)).toBeNull();
    const [row] = await outboxRows(`type = 'provider.create_payment' AND payload->>'topupId' = $1`, [topupId]);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, payload: { topupId, accountId: account, currency: 'INR', amountPaise: '25000' } });

    const { worker } = makeWorker();
    const outcomes = await worker.tick();

    expect(outcomes).toContainEqual(expect.objectContaining({ status: 'sent', id: row!.id }));
    const payments = provider.paymentsForReference(topupId);
    expect(payments).toHaveLength(1);
    expect(await recordedPaymentId(topupId)).toBe(payments[0]!.id);
    // The key the provider dedupes on is our top-up id.
    expect(provider.createPayment({ amountPaise: '1', currency: 'INR', reference: 'x', idempotencyKey: topupId }).id).toBe(payments[0]!.id);
    expect(await outboxRows('id = $1', [row!.id])).toMatchObject([{ status: 'sent' }]);
  });

  test('3. the worker crashes after calling the provider but before marking the row sent: the retry leaves exactly ONE payment', async () => {
    const account = await createAccount(app, 'user');
    const topupId = await postTopup(account);

    let crashes = 0;
    const { worker } = makeWorker({
      options: {
        testHooks: {
          beforeCommit: async () => {
            crashes++;
            throw new Error('simulated crash: process killed after the provider call');
          },
        },
      },
    });
    await expect(worker.tick()).rejects.toThrow(/simulated crash/);

    // The provider got the call; our side recorded nothing (the transaction died).
    expect(crashes).toBe(1);
    expect(provider.paymentsForReference(topupId)).toHaveLength(1);
    expect(await recordedPaymentId(topupId)).toBeNull();
    expect(await outboxRows(`payload->>'topupId' = $1`, [topupId])).toMatchObject([{ status: 'pending', attempts: 0 }]);

    // "Restart": a healthy worker retries the same row.
    const { worker: healthy } = makeWorker();
    await healthy.tick();
    const payments = provider.paymentsForReference(topupId);
    expect(payments).toHaveLength(1); // the Idempotency-Key did its job
    expect(await recordedPaymentId(topupId)).toBe(payments[0]!.id);
    expect(await outboxRows(`payload->>'topupId' = $1`, [topupId])).toMatchObject([{ status: 'sent' }]);
  });

  test('4. two worker instances run at the same time without ever processing the same row (SKIP LOCKED)', async () => {
    await drainOutbox();
    const tag = await enqueueEvents(20);

    // One shared sink so we can see both workers inside it at once.
    const sink = new MemorySink();
    sink.delayMs = 30;
    const a = makeWorker({ sink });
    const b = makeWorker({ sink });
    const started = Date.now();
    await Promise.all([a.worker.tick(20), b.worker.tick(20)]);
    const elapsed = Date.now() - started;

    expect(sink.deliveries).toHaveLength(20);
    expect(new Set(sink.deliveries).size).toBe(20); // every row delivered exactly once
    // SKIP LOCKED is what makes them concurrent: a worker never waits for a row the
    // other one holds, so two deliveries are in flight at once. With plain FOR UPDATE
    // they would take turns (maxInFlight 1, ~20 x 30 ms).
    expect(sink.maxInFlight).toBe(2);
    expect(elapsed).toBeLessThan(20 * 30 * 0.8);
    expect(await outboxRows(...tagged(tag, `status <> 'sent'`))).toEqual([]);
  });

  test('5. a failing handler backs off with jitter, records last_error, and ends as dead after N attempts', async () => {
    await drainOutbox();
    const tag = await enqueueEvents(1);
    const [row] = await outboxRows(...tagged(tag));
    const sink = new MemorySink();
    sink.failAlways = new Error('downstream is on fire');
    const options: WorkerOptions = { maxAttempts: 3, backoffBaseMs: 40, random: () => 0.5 }; // jitter factor exactly 1.0
    const { worker } = makeWorker({ sink, options });

    // attempt 1 -> retry in 40 ms
    let t0 = Date.now();
    expect(await worker.tick()).toMatchObject([{ status: 'retry', id: row!.id, error: 'Error: downstream is on fire' }]);
    let [after] = await outboxRows(...tagged(tag));
    expect(after).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Error: downstream is on fire' });
    expect(after!.available_at.getTime()).toBeGreaterThan(t0); // pushed into the future
    expect(await worker.tick()).toEqual([]); // not due yet: nothing processed
    await new Promise((r) => setTimeout(r, 60));

    // attempt 2 -> retry in 80 ms
    t0 = Date.now();
    expect(await worker.tick()).toMatchObject([{ status: 'retry', id: row!.id }]);
    [after] = await outboxRows(...tagged(tag));
    expect(after).toMatchObject({ status: 'pending', attempts: 2 });
    expect(after!.available_at.getTime() - t0).toBeGreaterThanOrEqual(70);
    await new Promise((r) => setTimeout(r, 100));

    // attempt 3 -> dead, never silently dropped
    expect(await worker.tick()).toMatchObject([{ status: 'dead', id: row!.id }]);
    [after] = await outboxRows(...tagged(tag));
    expect(after).toMatchObject({ status: 'dead', attempts: 3, last_error: 'Error: downstream is on fire' });
    expect(await worker.tick()).toEqual([]); // dead rows are never picked up again

    // The curve itself: doubling, capped, with jitter in [0.5, 1.5).
    expect(backoffMs(0, { backoffBaseMs: 1000, random: () => 0.5 })).toBe(1000);
    expect(backoffMs(3, { backoffBaseMs: 1000, random: () => 0.5 })).toBe(8000);
    expect(backoffMs(20, { backoffBaseMs: 1000, backoffCapMs: 300_000, random: () => 0.5 })).toBe(300_000);
    expect(backoffMs(0, { backoffBaseMs: 1000, random: () => 0 })).toBe(500);
    expect(backoffMs(0, { backoffBaseMs: 1000, random: () => 0.999 })).toBe(1499);
  });

  test('6. a webhook that arrives before the paymentId was recorded still matches by reference', async () => {
    const account = await createAccount(app, 'user');
    const topupId = await postTopup(account);
    // The worker called the provider and crashed before recording (as in test 3):
    // the provider has the payment, we have no paymentId.
    const payment = provider.createPayment({ amountPaise: '25000', currency: 'INR', reference: topupId, idempotencyKey: topupId });
    expect(await recordedPaymentId(topupId)).toBeNull();

    const [report] = await provider.settle(payment.id, 'succeeded');

    expect(report!.attempts[0]!.body).toEqual({ received: true, result: 'posted' });
    expect(await balanceOf(app, account)).toBe(25_000n);
    // The worker's retry later records the same paymentId; nothing conflicts.
    const { worker } = makeWorker();
    await worker.tick();
    expect(await recordedPaymentId(topupId)).toBe(payment.id);
    expect(provider.paymentsForReference(topupId)).toHaveLength(1);

    // A reference that points at a top-up already tied to a DIFFERENT payment is not trusted.
    const other = provider.createPayment({ amountPaise: '25000', currency: 'INR', reference: topupId, idempotencyKey: 'some-other-key' });
    const [bogus] = await provider.settle(other.id, 'succeeded');
    expect(bogus!.attempts[0]!.body).toMatchObject({ result: 'unmatched', detail: expect.stringContaining('which has payment') });
    expect(await balanceOf(app, account)).toBe(25_000n);
  });

  test('7. the notification sink receives each event at least once and dedupes by outbox id', async () => {
    await drainOutbox();
    const tag = await enqueueEvents(3);
    const sink = new MemorySink();
    let crashOnce = true;
    const { worker } = makeWorker({
      sink,
      options: {
        testHooks: {
          beforeCommit: async () => {
            if (crashOnce) {
              crashOnce = false;
              throw new Error('crash after delivering, before marking sent');
            }
          },
        },
      },
    });

    await expect(worker.tick()).rejects.toThrow(/crash after delivering/); // row 1 delivered, not marked
    await worker.tick(); // row 1 delivered AGAIN, then rows 2 and 3

    expect(sink.deliveries).toHaveLength(4); // at-least-once: 4 deliveries for 3 events
    expect(sink.received).toHaveLength(3); // the consumer saw each event once
    expect(sink.duplicates).toBe(1);
    expect(await outboxRows(...tagged(tag, `status <> 'sent'`))).toEqual([]);

    // The HTTP sink's receiver (mock-provider/sink.ts) applies the same rule.
    const store = new SinkStore();
    expect(store.record('42', { type: 'transfer.posted' })).toEqual({ duplicate: false });
    expect(store.record('42', { type: 'transfer.posted' })).toEqual({ duplicate: true });
    expect(store.record('43', {})).toEqual({ duplicate: false });
    expect(store.count).toBe(2);
    expect(store.duplicates).toBe(1);
  });

  test(
    '8. SIGTERM: the real worker process finishes the row in progress, takes no new rows, and exits 0',
    async () => {
      await drainOutbox();
      // A slow HTTP sink in this test; the worker process delivers to it.
      const received: string[] = [];
      let firstDelivery: (() => void) | null = null;
      const slowSink: Server = createServer((req, res) => {
        received.push(req.headers['outbox-id'] as string);
        firstDelivery?.();
        firstDelivery = null;
        setTimeout(() => res.writeHead(200).end('{}'), 400);
      });
      await new Promise<void>((r) => slowSink.listen(0, r));
      const sinkUrl = `http://127.0.0.1:${(slowSink.address() as { port: number }).port}/notifications`;
      const tag = await enqueueEvents(5);

      // The worker tags its database sessions (node-postgres reads PGAPPNAME), so
      // we can check afterwards that the process is really gone, not orphaned.
      const appName = `test8-worker-${randomUUID().slice(0, 8)}`;
      const child = spawnTs('src/worker/main.ts', [], {
        NOTIFICATION_SINK_URL: sinkUrl,
        PROVIDER_URL: 'http://127.0.0.1:9',
        WORKER_POLL_INTERVAL_MS: '100',
        PGAPPNAME: appName,
      });
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));

      try {
        // Wait until the first delivery is in flight, then ask the worker to stop.
        await new Promise<void>((r) => (firstDelivery = r));
        child.kill('SIGTERM');
        const exit = await exitWithin(child, 10_000);

        // It EXITED with 0, within 10 s. It was not killed by the signal (signal
        // would be 'SIGTERM') and it is not still running ('still running').
        expect(exit, output).toEqual({ code: 0, signal: null });
        expect(output).toContain('SIGTERM received: finishing the current row');
        expect(output).toContain('stopped cleanly');
        expect(received).toHaveLength(1); // the in-flight row was finished, no new row taken
        expect(await outboxRows(...tagged(tag, `status = 'sent'`))).toHaveLength(1);
        expect(await outboxRows(...tagged(tag, `status = 'pending'`))).toHaveLength(4);
        // And nothing is left behind: no session of that worker is still connected.
        // (Queried as ledger_worker: application_name is visible to any role, but
        // only the same role sees a session's state.)
        expect(await sessionsNamed(appName)).toBe(0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        slowSink.closeAllConnections();
        await new Promise<void>((r) => slowSink.close(() => r()));
        await drainOutbox();
      }
    },
    30_000,
  );

  test('9. a provider that hangs past the timeout fails the row, which backs off and succeeds later with exactly one payment', async () => {
    await drainOutbox();
    const account = await createAccount(app, 'user');
    const topupId = await postTopup(account);

    // An HTTP provider that hangs on the FIRST request and behaves afterwards.
    let calls = 0;
    const flaky: Server = createServer((req, res) => {
      calls++;
      if (calls === 1) return; // hang: never answer
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const input = JSON.parse(body) as { amountPaise: string; currency: string; reference: string };
        const payment = provider.createPayment({ ...input, idempotencyKey: req.headers['idempotency-key'] as string });
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ paymentId: payment.id }));
      });
    });
    await new Promise<void>((r) => flaky.listen(0, r));
    const client = new HttpProviderClient(`http://127.0.0.1:${(flaky.address() as { port: number }).port}`, 300); // 300 ms instead of 3 s
    const { worker } = makeWorker({ provider: client, options: { backoffBaseMs: 50, random: () => 0.5 } });

    try {
      const first = await worker.tick();
      expect(first).toMatchObject([{ status: 'retry', error: expect.stringContaining('TimeoutError') }]);
      expect(await outboxRows(`payload->>'topupId' = $1`, [topupId])).toMatchObject([{ status: 'pending', attempts: 1 }]);
      expect(provider.paymentsForReference(topupId)).toHaveLength(0);

      await new Promise((r) => setTimeout(r, 80));
      const second = await worker.tick();
      expect(second).toMatchObject([{ status: 'sent' }]);
      expect(provider.paymentsForReference(topupId)).toHaveLength(1);
      expect(await recordedPaymentId(topupId)).toBe(provider.paymentsForReference(topupId)[0]!.id);
      expect(calls).toBe(2);
    } finally {
      flaky.closeAllConnections();
      await new Promise<void>((r) => flaky.close(() => r()));
    }
  });

  test('10. processOneRow is idle on an empty outbox and leaves no transaction open', async () => {
    await drainOutbox();
    const { handlers } = makeWorker();
    expect(await processOneRow(workerPool, handlers)).toEqual({ status: 'idle' });
    const { rows } = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'ledger_worker' AND state = 'idle in transaction'`);
    expect(rows[0]!.n).toBe(0);
  });
});
