// The outbox worker process:  npm run worker
//
// Connects as ledger_worker, polls the outbox with FOR UPDATE SKIP LOCKED (so
// several copies can run side by side), performs each row's side effect, and
// stops cleanly on SIGTERM/SIGINT: the row in progress is finished, no new row
// is taken, then the process exits 0.
import { z } from 'zod';
import { createPool } from '../db.js';
import { HttpProviderClient } from '../provider/client.js';
import { createHandlers } from './handlers.js';
import { Worker } from './run.js';
import { HttpNotificationSink } from './sinks.js';

const EnvSchema = z.object({
  WORKER_DATABASE_URL: z.string().startsWith('postgres://'),
  PROVIDER_URL: z.url(),
  NOTIFICATION_SINK_URL: z.url(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  WORKER_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
});

const env = EnvSchema.safeParse(process.env);
if (!env.success) {
  console.error(`Invalid worker environment:\n${z.prettifyError(env.error)}`);
  process.exit(1);
}

const pool = createPool(env.data.WORKER_DATABASE_URL, { max: 2 });
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
    log: (line) => console.log(`[worker] ${line}`),
  },
);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received: finishing the current row, taking no new work`);
  worker.stop();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[worker] ready');
await worker.start();
await pool.end();
console.log('[worker] stopped cleanly');
