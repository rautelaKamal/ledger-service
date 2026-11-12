// Step 6a: health vs readiness, graceful shutdown, metrics, and log correlation.
//
// Setup: beforeAll TRUNCATEs the ledger (re-seeding bank_settlement). Tests run
// the real app in-process (startTestServer) except the shutdown test, which
// spawns the real API process. Log lines are captured with useLogger().

import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { MockProvider } from '../mock-provider/provider.js';
import { signWebhook } from '../mock-provider/signature.js';
import { createPool, type Pool } from '../src/db.js';
import { createLogger, useLogger } from '../src/logger.js';
import { createApiMetrics } from '../src/metrics.js';
import { MIGRATIONS_DIR } from '../src/migrations.js';
import { recordRun, type ReconcileReport } from '../src/reconcile/run.js';
import { createHandlers } from '../src/worker/handlers.js';
import { startWorkerHttpServer } from '../src/worker/http.js';
import { createWorkerMetrics } from '../src/worker/metrics.js';
import { Worker } from '../src/worker/run.js';
import { HttpNotificationSink } from '../src/worker/sinks.js';
import { createAccount, fundAccount } from './helpers.js';
import { TEST_WEBHOOK_SECRET, startTestServer, type TestServer } from './http.js';
import { resetLedger } from './reset.js';
import { exitWithin, freePort, spawnTs } from './spawn.js';

let app: Pool; // ledger_app
let owner: Pool; // ledger_owner
let workerPool: Pool; // ledger_worker
let reconciler: Pool; // ledger_reconciler
const toClose: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: 10 });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  workerPool = createPool(process.env.WORKER_DATABASE_URL!, { max: 3 });
  reconciler = createPool(process.env.RECONCILER_DATABASE_URL!, { max: 2 });
  await resetLedger(owner);
});

afterEach(async () => {
  while (toClose.length) await toClose.pop()!.close();
});

afterAll(async () => {
  await Promise.all([app.end(), owner.end(), workerPool.end(), reconciler.end()]);
});

// ───────────── helpers ─────────────

async function server(pool: Pool, options: Parameters<typeof startTestServer>[1] = {}): Promise<TestServer> {
  const s = await startTestServer(pool, options);
  toClose.push(s);
  return s;
}

/** Capture every log line written while `fn` runs (as parsed JSON objects). */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[]; raw: string }> {
  const chunks: string[] = [];
  const previous = useLogger(createLogger({ level: 'debug' }, { write: (s: string) => void chunks.push(s) }));
  try {
    const result = await fn();
    const raw = chunks.join('');
    return { result, raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
  } finally {
    useLogger(previous);
  }
}

async function postTransfer(
  url: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: unknown }> {
  const res = await fetch(`${url}/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': 'obs-client', 'idempotency-key': `key-${randomUUID()}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

async function fundedPair(paise = 10_000n): Promise<{ a: string; b: string }> {
  const a = await createAccount(app, 'user');
  const b = await createAccount(app, 'user');
  await fundAccount(owner, a, paise);
  return { a, b };
}

/** One sample's value from Prometheus text format, or undefined if the series is absent. */
function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : undefined;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ───────────── tests ─────────────

describe('health, readiness and shutdown', () => {
  test('1. /healthz is 200 whenever the process runs; /readyz is 200 only when the database is up and fully migrated', async () => {
    // Healthy, migrated.
    const ok = await server(app);
    expect(await (await fetch(`${ok.url}/healthz`)).json()).toEqual({ status: 'alive' });
    const ready = await fetch(`${ok.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true, checks: { database: 'up', migrations: 'up_to_date', shutdown: 'no' } });

    // The code knows a migration the database does not have yet.
    const dir = await mkdtemp(join(tmpdir(), 'migrations-ahead-'));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await writeFile(join(dir, '999_not_applied_yet.sql'), 'SELECT 1;');
    const ahead = await server(app, { migrationsDir: dir });
    const notMigrated = await fetch(`${ahead.url}/readyz`);
    expect(notMigrated.status).toBe(503);
    expect(await notMigrated.json()).toMatchObject({ ready: false, checks: { database: 'up', migrations: 'pending' }, pending: ['999_not_applied_yet.sql'] });
    expect((await fetch(`${ahead.url}/healthz`)).status).toBe(200); // alive, just not ready

    // The database is unreachable.
    const deadPool = createPool('postgres://ledger_app:x@127.0.0.1:9/nowhere');
    try {
      const noDb = await server(deadPool);
      const down = await fetch(`${noDb.url}/readyz`);
      expect(down.status).toBe(503);
      expect(await down.json()).toMatchObject({ ready: false, checks: { database: 'down' } });
      expect((await fetch(`${noDb.url}/healthz`)).status).toBe(200);
    } finally {
      await deadPool.end();
    }

    // Shutting down: alive, but no longer ready.
    let stopping = false;
    const draining = await server(app, { isShuttingDown: () => stopping });
    stopping = true;
    const drainingReady = await fetch(`${draining.url}/readyz`);
    expect(drainingReady.status).toBe(503);
    expect(await drainingReady.json()).toMatchObject({ ready: false, checks: { shutdown: 'in_progress' } });
  });

  test(
    '2. SIGTERM: the API finishes an in-flight transfer, refuses new connections, and exits 0',
    async () => {
      const { a, b } = await fundedPair();
      const port = await freePort();
      const child = spawnTs('src/server.ts', [], {
        PORT: String(port),
        WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
        LOG_LEVEL: 'info',
        SHUTDOWN_GRACE_MS: '10000',
      });
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      const url = `http://127.0.0.1:${port}`;

      // Hold account A's row, so a transfer from A has to wait: an in-flight request.
      const holder = await app.connect();
      try {
        for (let i = 0; i < 50 && !output.includes('api listening'); i++) await new Promise((r) => setTimeout(r, 100));
        expect(output).toContain('api listening');

        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [a]);
        const inFlight = postTransfer(url, { fromAccountId: a, toAccountId: b, amountPaise: '100' });
        await new Promise((r) => setTimeout(r, 300)); // it is now waiting on the row lock

        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));

        // New connections are refused ...
        await expect(fetch(`${url}/healthz`)).rejects.toThrow();
        // ... but the request already in progress is allowed to finish.
        await holder.query('ROLLBACK');
        const res = await inFlight;
        expect(res.status).toBe(201);

        const exit = await exitWithin(child, 10_000);
        expect(exit, output).toEqual({ code: 0, signal: null });
        expect(output).toContain('shutdown started');
        expect(output).toContain('shutdown complete');
      } finally {
        holder.release();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
    30_000,
  );

  test('3. the worker HTTP server answers /healthz, /readyz and /metrics, including outbox and dead-row gauges', async () => {
    let stopping = false;
    const metrics = createWorkerMetrics(workerPool);
    const http = await startWorkerHttpServer({ pool: workerPool, metrics, port: 0, isShuttingDown: () => stopping });
    toClose.push({ close: () => new Promise((r) => http.close(() => r())) });
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ status: 'alive' });
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    expect((await fetch(`${url}/nope`)).status).toBe(404);

    // One due pending row (lag > 0) and one dead row.
    await app.query(`INSERT INTO outbox (type, payload) VALUES ('transfer.posted', '{"gauge":"pending"}'), ('transfer.posted', '{"gauge":"dead"}')`);
    await workerPool.query(`UPDATE outbox SET status = 'dead', attempts = 8, last_error = 'gave up' WHERE payload->>'gauge' = 'dead'`);
    await new Promise((r) => setTimeout(r, 1_100)); // let the pending row age a little
    const text = await (await fetch(`${url}/metrics`)).text();
    expect(sample(text, 'outbox_dead_rows')).toBeGreaterThanOrEqual(1);
    expect(sample(text, 'outbox_pending_rows')).toBeGreaterThanOrEqual(1);
    expect(sample(text, 'outbox_lag_seconds')).toBeGreaterThanOrEqual(1);

    stopping = true;
    const draining = await fetch(`${url}/readyz`);
    expect(draining.status).toBe(503);
    expect(await draining.json()).toMatchObject({ checks: { shutdown: 'in_progress' } });

    // Clean up the rows this test made (the dead one stays dead; that is fine for later tests
    // only if they do not count dead rows, so drain the pending one).
    const worker = new Worker(workerPool, createHandlers({ provider: { createPayment: async () => ({ paymentId: 'x' }) }, sink: { deliver: async () => {} } }));
    await worker.tick();
  });
});

describe('metrics', () => {
  test('4. API counters move with what happened, labels use route patterns, and no ids or keys appear', async () => {
    const metrics = createApiMetrics();
    const s = await server(app, { metrics });
    const { a, b } = await fundedPair(1_000n);
    const key = `key-${randomUUID()}`;
    const body = { fromAccountId: a, toAccountId: b, amountPaise: '100' };

    expect((await postTransfer(s.url, body, { 'idempotency-key': key })).status).toBe(201);
    expect((await postTransfer(s.url, body, { 'idempotency-key': key })).status).toBe(201); // replay
    expect((await postTransfer(s.url, { ...body, amountPaise: '999999' })).status).toBe(422); // insufficient funds
    expect((await fetch(`${s.url}/accounts/${a}`)).status).toBe(404); // unknown route, with an id in the URL

    // One genuine webhook for an unknown payment, one forged.
    const provider = new MockProvider({ secret: TEST_WEBHOOK_SECRET, webhookUrl: `${s.url}/webhooks/provider` });
    const ghost = provider.createPayment({ amountPaise: '1', currency: 'INR', reference: 'nobody' });
    expect((await provider.deliver(provider.buildEvent(ghost.id, 'succeeded'))).status).toBe(200);
    expect((await provider.deliver(provider.buildEvent(ghost.id, 'succeeded'), { signWith: 'wrong' })).status).toBe(401);

    const text = await (await fetch(`${s.url}/metrics`)).text();
    expect(sample(text, 'ledger_transfers_total{result="created"}')).toBe(1);
    expect(sample(text, 'ledger_transfers_total{result="insufficient_funds"}')).toBe(1);
    expect(sample(text, 'idempotency_replays_total{route="/transfers"}')).toBe(1);
    expect(sample(text, 'webhook_events_total{result="unmatched"}')).toBe(1);
    expect(sample(text, 'webhook_events_total{result="invalid_signature"}')).toBe(1);
    expect(sample(text, 'http_requests_total{method="POST",route="/transfers",status="201"}')).toBe(2);
    expect(sample(text, 'http_requests_total{method="POST",route="/transfers",status="422"}')).toBe(1);
    expect(sample(text, 'http_requests_total{method="GET",route="unmatched",status="404"}')).toBe(1);
    expect(sample(text, 'http_request_duration_seconds_count{method="POST",route="/transfers",status="201"}')).toBe(2);

    // Low cardinality: no UUIDs (account ids, request ids), no keys, only known route patterns.
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain(key);
    const routes = new Set([...text.matchAll(/route="([^"]*)"/g)].map((m) => m[1]));
    for (const route of routes) {
      expect(['/transfers', '/topups', '/webhooks/provider', '/metrics', '/healthz', '/readyz', '/health', 'unmatched']).toContain(route);
    }
  });

  test('5. the worker exposes the latest reconciliation run: ok, problems per check, and when it ran', async () => {
    const metrics = createWorkerMetrics(workerPool);
    const scrape = async (): Promise<string> => metrics.registry.metrics();

    // No run yet in this (freshly truncated) database: the gauges have no samples.
    expect(sample(await scrape(), 'reconciliation_last_run_ok')).toBeUndefined();

    const report = (ok: boolean, summary: ReconcileReport['summary'], problems: ReconcileReport['problems']): ReconcileReport => ({
      ok,
      ranAt: new Date().toISOString(),
      durationMs: 12,
      summary,
      problems,
    });
    const zero = { account_balances: 0, posted_transactions_balanced: 0, stale_pending_topups: 0, webhook_anomalies: 0, outbox_problems: 0 };
    await recordRun(reconciler, report(true, zero, []));
    await new Promise((r) => setTimeout(r, 1_100)); // past the 1 s scrape cache
    let text = await scrape();
    expect(sample(text, 'reconciliation_last_run_ok')).toBe(1);
    expect(sample(text, 'reconciliation_last_run_problems{check="account_balances"}')).toBe(0);

    await recordRun(
      reconciler,
      report(false, { ...zero, account_balances: 2, outbox_problems: 1 }, [
        { check: 'account_balances', id: 'a', detail: 'x' },
        { check: 'account_balances', id: 'b', detail: 'y' },
        { check: 'outbox_problems', id: '1', detail: 'z' },
      ]),
    );
    await new Promise((r) => setTimeout(r, 1_100));
    text = await scrape();
    expect(sample(text, 'reconciliation_last_run_ok')).toBe(0);
    expect(sample(text, 'reconciliation_last_run_problems{check="account_balances"}')).toBe(2);
    expect(sample(text, 'reconciliation_last_run_problems{check="outbox_problems"}')).toBe(1);
    expect(sample(text, 'reconciliation_last_run_problems{check="webhook_anomalies"}')).toBe(0);
    expect(Math.abs(sample(text, 'reconciliation_last_run_timestamp_seconds')! - Date.now() / 1000)).toBeLessThan(30);
    // The problems list itself is not exposed (and the worker cannot read it).
    await expect(workerPool.query('SELECT problems FROM reconciliation_runs')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('logs', () => {
  test('6. one request id follows a transfer: response header -> outbox payload -> worker log -> notification header', async () => {
    const s = await server(app);
    const { a, b } = await fundedPair();
    const requestId = `trace-${randomUUID().slice(0, 8)}`;

    // A sink that records the headers it receives.
    const seen: IncomingHttpHeaders[] = [];
    const sinkServer: Server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on('end', () => res.writeHead(200).end('{}'));
    });
    await new Promise<void>((r) => sinkServer.listen(0, r));
    toClose.push({ close: () => new Promise((r) => sinkServer.close(() => r())) });
    const sink = new HttpNotificationSink(`http://127.0.0.1:${(sinkServer.address() as { port: number }).port}/notifications`);

    const { result: res, lines } = await captureLogs(async () => {
      const r = await postTransfer(s.url, { fromAccountId: a, toAccountId: b, amountPaise: '250' }, { 'x-request-id': requestId });
      const worker = new Worker(workerPool, createHandlers({ provider: { createPayment: async () => ({ paymentId: 'x' }) }, sink }));
      await worker.tick();
      return r;
    });

    // 1. the API echoes the id
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe(requestId);
    const transactionId = (res.json as { transactionId: string }).transactionId;
    // 2. the outbox row carries it
    const { rows } = await owner.query<{ id: bigint; payload: { requestId?: string } }>(
      `SELECT id, payload FROM outbox WHERE type = 'transfer.posted' AND payload->>'transactionId' = $1`,
      [transactionId],
    );
    expect(rows[0]!.payload.requestId).toBe(requestId);
    // 3. the API's and the worker's log lines carry it
    const mine = lines.filter((l) => l.request_id === requestId);
    expect(mine.map((l) => l.msg)).toEqual(expect.arrayContaining(['transfer', 'request', 'outbox row handled']));
    expect(mine.find((l) => l.msg === 'outbox row handled')).toMatchObject({ type: 'transfer.posted', outcome: 'sent', outbox_id: rows[0]!.id.toString() });
    // 4. the notification arrives with it
    expect(seen.find((h) => h['outbox-id'] === rows[0]!.id.toString())?.['x-request-id']).toBe(requestId);

    // An unsafe incoming id is replaced, not echoed into logs and headers.
    const odd = await postTransfer(s.url, { fromAccountId: a, toAccountId: b, amountPaise: '1' }, { 'x-request-id': 'has spaces and "quotes"' });
    expect(odd.headers.get('x-request-id')).toMatch(UUID);
  });

  test('7. webhook logs record what happened, never the signature, the secret or the raw body', async () => {
    const s = await server(app);
    const provider = new MockProvider({ secret: TEST_WEBHOOK_SECRET, webhookUrl: `${s.url}/webhooks/provider` });
    const marker = `body-marker-${randomUUID()}`; // appears only inside the webhook body
    const ghost = provider.createPayment({ amountPaise: '1', currency: 'INR', reference: marker });
    const event = provider.buildEvent(ghost.id, 'succeeded');
    const rawBody = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const signature = signWebhook(TEST_WEBHOOK_SECRET, rawBody, t);

    const { raw, lines } = await captureLogs(async () => {
      await provider.deliver(event, { timestamp: t, rawBody }); // genuine
      await provider.deliver(event, { timestamp: t, rawBody, signWith: 'forger' }); // forged
      await fetch(`${s.url}/webhooks/provider`, { method: 'POST', body: '{"not":"signed"}' }); // unsigned
    });

    expect(lines.find((l) => l.msg === 'webhook')).toMatchObject({ event_id: event.id, event_type: 'payment.succeeded', result: 'unmatched' });
    expect(lines.filter((l) => l.msg === 'webhook rejected').map((l) => l.reason)).toEqual(['signature_mismatch', 'missing_header']);
    expect(raw).not.toContain(signature.split('v1=')[1]!);
    expect(raw).not.toContain(TEST_WEBHOOK_SECRET);
    expect(raw).not.toContain(marker);
    expect(raw).not.toContain(rawBody);
  });
});
