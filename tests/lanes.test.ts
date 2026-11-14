// Step 6a.1: outbox lanes and concurrent worker loops.
//
// Uses stub handlers (no provider, no ledger writes) so each test controls
// exactly what is queued. Rows are tagged per test (payload.tag) and drained
// afterwards. The API role queues rows (INSERT type, payload only), as in prod.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import { createHandlers, type Handlers, type OutboxRow } from '../src/worker/handlers.js';
import { createWorkerMetrics } from '../src/worker/metrics.js';
import { processOneRow } from '../src/worker/outbox.js';
import { Worker } from '../src/worker/run.js';
import { HttpNotificationSink, MemorySink, type OutboxEvent } from '../src/worker/sinks.js';
import { resetLedger } from './reset.js';

let app: Pool; // ledger_app
let owner: Pool; // ledger_owner
let workerPool: Pool; // ledger_worker

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: 4 });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  workerPool = createPool(process.env.WORKER_DATABASE_URL!, { max: 10 });
  await resetLedger(owner);
});

afterEach(async () => {
  await drain();
});

afterAll(async () => {
  await Promise.all([app.end(), owner.end(), workerPool.end()]);
});

// ───────────── helpers ─────────────

/** Handlers that do nothing but remember which rows they handled, in order. */
function recordingHandlers(): { handlers: Handlers; handled: OutboxRow[] } {
  const handled: OutboxRow[] = [];
  const record = async (row: OutboxRow): Promise<void> => void handled.push(row);
  return {
    handled,
    handlers: { 'provider.create_payment': record, 'transfer.posted': record, 'topup.posted': record, 'topup.failed': record },
  };
}

/** Send every pending row with a no-op worker, so the next test starts clean. */
async function drain(): Promise<void> {
  const { handlers } = recordingHandlers();
  const worker = new Worker(workerPool, handlers);
  while ((await worker.tick(1000)).length > 0);
}

/**
 * Queue `n` rows of `type` in one statement, as the API would. The API role may
 * only INSERT (it cannot even read its own rows back, so no RETURNING), so the
 * ids are read as the owner. Returns this call's ids in insertion order.
 */
async function enqueue(type: string, n: number, tag: string): Promise<bigint[]> {
  await app.query(
    `INSERT INTO outbox (type, payload)
     SELECT $1, jsonb_build_object('tag', $2::text, 'n', g) FROM generate_series(1, $3::int) g`,
    [type, tag, n],
  );
  const { rows } = await owner.query<{ id: bigint }>(
    `SELECT id FROM outbox WHERE payload->>'tag' = $1 AND type = $2 ORDER BY id DESC LIMIT $3`,
    [tag, type, n],
  );
  return rows.map((r) => r.id).reverse();
}

async function statuses(tag: string): Promise<Record<string, number>> {
  const { rows } = await owner.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM outbox WHERE payload->>'tag' = $1 GROUP BY status`,
    [tag],
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : undefined;
}

const newTag = (): string => `lane-${randomUUID().slice(0, 8)}`;

// ───────────── tests ─────────────

describe('outbox lanes', () => {
  test('1. a command queued AFTER 500 events is processed FIRST (one loop, lane "all")', async () => {
    const tag = newTag();
    await enqueue('transfer.posted', 500, tag); // older
    const [commandId] = await enqueue('provider.create_payment', 1, tag); // newest of all
    const { handlers, handled } = recordingHandlers();

    const outcome = await processOneRow(workerPool, handlers, { lane: 'all' });

    expect(outcome).toMatchObject({ status: 'sent', id: commandId, type: 'provider.create_payment' });
    expect(handled.map((r) => r.type)).toEqual(['provider.create_payment']);
  });

  test('2. each lane takes only its own rows: the events lane never takes a command, the commands lane skips the backlog', async () => {
    const tag = newTag();
    await enqueue('transfer.posted', 500, tag);
    const [commandId] = await enqueue('provider.create_payment', 1, tag);
    const events = recordingHandlers();
    const commands = recordingHandlers();

    // A commands-lane worker gets the command at once, despite 500 older events.
    expect(await processOneRow(workerPool, commands.handlers, { lane: 'commands' })).toMatchObject({ status: 'sent', id: commandId });
    expect(await processOneRow(workerPool, commands.handlers, { lane: 'commands' })).toEqual({ status: 'idle' });

    // An events-lane worker drains every event and never sees a command.
    const another = await enqueue('provider.create_payment', 1, tag);
    const worker = new Worker(workerPool, events.handlers, { lane: 'events' });
    while ((await worker.tick(1000)).length > 0);
    expect(events.handled.filter((r) => (r.payload as { tag?: string }).tag === tag)).toHaveLength(500);
    expect(events.handled.some((r) => r.type === 'provider.create_payment')).toBe(false);
    expect(await statuses(tag)).toEqual({ sent: 501, pending: 1 }); // the second command waits for its lane
    expect(another).toHaveLength(1);
  });
});

describe('concurrent worker loops', () => {
  test('3. four loops in one worker deliver 200 rows in parallel, each exactly once', async () => {
    const tag = newTag();
    const ids = await enqueue('transfer.posted', 200, tag);
    const sink = new MemorySink();
    sink.delayMs = 20;
    const worker = new Worker(workerPool, createHandlers({ provider: { createPayment: async () => ({ paymentId: 'x' }) }, sink }), {
      lane: 'events',
      concurrency: 4,
      pollIntervalMs: 20,
    });

    const running = worker.start();
    for (let i = 0; i < 200 && (await statuses(tag)).sent !== 200; i++) await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    await running;

    const mine = sink.deliveries.filter((id) => ids.includes(BigInt(id)));
    expect(mine).toHaveLength(200);
    expect(new Set(mine).size).toBe(200); // never twice
    expect(sink.maxInFlight).toBe(4); // and really four at a time
    expect(await statuses(tag)).toEqual({ sent: 200 });
  });

  test('4. stop() with several loops: each finishes its current row, takes no new one, and start() returns only then', async () => {
    const tag = newTag();
    await enqueue('transfer.posted', 12, tag);
    const sink = new MemorySink();
    sink.delayMs = 300;
    const worker = new Worker(workerPool, createHandlers({ provider: { createPayment: async () => ({ paymentId: 'x' }) }, sink }), {
      lane: 'events',
      concurrency: 3,
      pollIntervalMs: 20,
    });

    const running = worker.start();
    await new Promise((r) => setTimeout(r, 100)); // three rows are now mid-delivery
    worker.stop();
    await running;

    const atReturn = sink.deliveries.length;
    const sentAtReturn = (await statuses(tag)).sent ?? 0;
    expect(atReturn).toBe(3); // each loop finished the row it had
    expect(sentAtReturn).toBe(3); // and committed it before start() returned
    await new Promise((r) => setTimeout(r, 500));
    expect(sink.deliveries.length).toBe(atReturn); // nothing ran after start() returned
    expect(await statuses(tag)).toEqual({ sent: 3, pending: 9 });
  });

  test('5. per-lane gauges report each lane\'s backlog and lag separately', async () => {
    await drain();
    const tag = newTag();
    await enqueue('provider.create_payment', 3, tag);
    await enqueue('transfer.posted', 5, tag);
    await new Promise((r) => setTimeout(r, 1_100)); // let them age

    const text = await createWorkerMetrics(workerPool).registry.metrics();

    expect(sample(text, 'outbox_lane_pending_rows{lane="commands"}')).toBe(3);
    expect(sample(text, 'outbox_lane_pending_rows{lane="events"}')).toBe(5);
    expect(sample(text, 'outbox_lane_lag_seconds{lane="commands"}')).toBeGreaterThanOrEqual(1);
    expect(sample(text, 'outbox_lane_lag_seconds{lane="events"}')).toBeGreaterThanOrEqual(1);
    expect(sample(text, 'outbox_pending_rows')).toBe(8); // the 6a total is unchanged
  });
});

describe('event ordering', () => {
  test('6. concurrent delivery is unordered; a consumer restores creation order by sequence (the outbox id)', async () => {
    const tag = newTag();
    const ids = await enqueue('transfer.posted', 20, tag);
    const lastId = ids[ids.length - 1]!;

    // A sink where OLDER events take LONGER, so arrival order is scrambled for sure.
    const arrived: OutboxEvent[] = [];
    const slowForOld = {
      deliver: async (event: OutboxEvent): Promise<void> => {
        await new Promise((r) => setTimeout(r, Number(lastId - BigInt(event.sequence)) * 8));
        arrived.push(event);
      },
    };
    const worker = new Worker(workerPool, createHandlers({ provider: { createPayment: async () => ({ paymentId: 'x' }) }, sink: slowForOld }), {
      lane: 'events',
      concurrency: 4,
      pollIntervalMs: 20,
    });
    const running = worker.start();
    for (let i = 0; i < 100 && arrived.length < 20; i++) await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    await running;

    const mine = arrived.filter((e) => (e.payload as { tag?: string }).tag === tag);
    expect(mine).toHaveLength(20);
    const arrivalOrder = mine.map((e) => BigInt(e.sequence));
    expect(arrivalOrder).not.toEqual(ids); // arrival order is NOT creation order ...

    // ... but the consumer can restore it: sort by sequence, as a 64-bit number.
    const restored = [...mine].sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1));
    expect(restored.map((e) => BigInt(e.sequence))).toEqual(ids);
    expect(restored.map((e) => (e.payload as { n: number }).n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const e of mine) {
      expect(e.sequence).toBe(e.outboxId);
      expect(e.createdAt).toBeInstanceOf(Date);
    }
  });

  test('7. the HTTP sink sends sequence and createdAt in every event body', async () => {
    const tag = newTag();
    const [id] = await enqueue('transfer.posted', 1, tag);
    const bodies: Record<string, unknown>[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const sink = new HttpNotificationSink(`http://127.0.0.1:${(server.address() as { port: number }).port}/notifications`);
      const worker = new Worker(workerPool, createHandlers({ provider: { createPayment: async () => ({ paymentId: 'x' }) }, sink }), { lane: 'events' });
      while ((await worker.tick(1000)).length > 0);

      const mine = bodies.find((b) => (b.payload as { tag?: string }).tag === tag);
      expect(mine).toMatchObject({ outboxId: id!.toString(), sequence: id!.toString(), type: 'transfer.posted' });
      expect(new Date(mine!.createdAt as string).toISOString()).toBe(mine!.createdAt);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
