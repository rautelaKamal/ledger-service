import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { logger } from './logger.js';
import { createApiMetrics } from './metrics.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
let shuttingDown = false;
const app = createApp(pool, {
  webhookSecret: config.WEBHOOK_SECRET,
  metrics: createApiMetrics({ defaultMetrics: true }),
  isShuttingDown: () => shuttingDown,
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'api listening');
});

/** How long in-flight requests get to finish before their connections are cut. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);

// Graceful shutdown (Kubernetes sends SIGTERM, waits terminationGracePeriodSeconds,
// then SIGKILL). In order:
//   1. /readyz starts answering 503, so the load balancer stops sending traffic
//   2. stop accepting new connections (server.close)
//   3. close idle keep-alive connections; busy ones get "Connection: close" on
//      their response and are closed once it is sent
//   4. wait for in-flight requests to finish (capped by SHUTDOWN_GRACE_MS)
//   5. close the database pool, exit 0
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown started: finishing in-flight requests, accepting no new connections');

  const force = setTimeout(() => {
    logger.warn({ grace_ms: SHUTDOWN_GRACE_MS }, 'grace period over: closing remaining connections');
    server.closeAllConnections();
  }, SHUTDOWN_GRACE_MS);
  force.unref();

  server.close(() => {
    void pool
      .end()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'error while closing the database pool');
        process.exit(1);
      });
  });
  server.closeIdleConnections();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
