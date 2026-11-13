// The outbox worker process:  npm run worker   (container: node dist/src/worker/main.js)
//
// Connects as ledger_worker, polls the outbox with FOR UPDATE SKIP LOCKED (so
// several copies can run side by side), performs each row's side effect, and
// stops cleanly on SIGTERM/SIGINT: the row in progress is finished, no new row
// is taken, then the process exits 0. A small HTTP server on WORKER_HTTP_PORT
// answers /healthz, /readyz and /metrics.
import type { Server } from 'node:http';
import { z } from 'zod';
import { createPool } from '../db.js';
import { logger } from '../logger.js';
import { HttpProviderClient } from '../provider/client.js';
import { createHandlers } from './handlers.js';
import { startWorkerHttpServer } from './http.js';
import { createWorkerMetrics } from './metrics.js';
import { Worker } from './run.js';
import { HttpNotificationSink } from './sinks.js';

const EnvSchema = z.object({
  WORKER_DATABASE_URL: z.string().startsWith('postgres://'),
  PROVIDER_URL: z.url(),
  NOTIFICATION_SINK_URL: z.url(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  WORKER_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  // 0 = pick any free port (tests); the container uses 9101.
  WORKER_HTTP_PORT: z.coerce.number().int().min(0).default(9101),
});

const env = EnvSchema.safeParse(process.env);
if (!env.success) {
  console.error(`Invalid worker environment:\n${z.prettifyError(env.error)}`);
  process.exit(1);
}

const pool = createPool(env.data.WORKER_DATABASE_URL, { max: 3 });
const metrics = createWorkerMetrics(pool, { defaultMetrics: true });
let stopping = false;
const worker = new Worker(
  pool,
  createHandlers({
    provider: new HttpProviderClient(env.data.PROVIDER_URL),
    sink: new HttpNotificationSink(env.data.NOTIFICATION_SINK_URL),
  }),
  {
    pollIntervalMs: env.data.WORKER_POLL_INTERVAL_MS,
    maxAttempts: env.data.WORKER_MAX_ATTEMPTS,
    backoffBaseMs: env.data.WORKER_BACKOFF_BASE_MS,
    onOutcome: (outcome, row, seconds) => metrics.record(outcome, row.type, seconds),
    // Kept for tests and the step 5 output format ("SIGTERM received: ..." etc.).
    log: (line) => console.log(`[worker] ${line}`),
  },
);

const http: Server = await startWorkerHttpServer({
  pool,
  metrics,
  port: env.data.WORKER_HTTP_PORT,
  isShuttingDown: () => stopping,
});
const address = http.address();
logger.info({ port: typeof address === 'object' && address ? address.port : null }, 'worker http listening');

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received: finishing the current row, taking no new work`);
  logger.info({ signal }, 'shutdown started: finishing the current row, taking no new work');
  worker.stop();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[worker] ready');
logger.info('worker ready');
await worker.start();
await new Promise<void>((resolve) => http.close(() => resolve()));
await pool.end();
logger.info('worker stopped cleanly');
console.log('[worker] stopped cleanly');
