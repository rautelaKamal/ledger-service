import express from 'express';
import { requestIdFrom, runWithRequestId } from './context.js';
import type { Pool } from './db.js';
import { errorBody } from './http/errors.js';
import { topupsRouter } from './http/topups.js';
import { transfersRouter } from './http/transfers.js';
import { webhooksRouter } from './http/webhooks.js';
import type { IdempotentOptions } from './idempotency.js';
import { logger } from './logger.js';
import { createApiMetrics, type ApiMetrics } from './metrics.js';
import { checkReadiness } from './readiness.js';
import type { WebhookTestHooks } from './webhooks/process.js';

export interface AppOptions extends IdempotentOptions {
  /** Shared secret the provider signs webhooks with (WEBHOOK_SECRET). */
  webhookSecret: string;
  /** Test-only fault injection. Only reachable through this option: never env, never a request. */
  testHooks?: WebhookTestHooks;
  /** Metrics registry for this app. Created if not given. */
  metrics?: ApiMetrics;
  /** True once SIGTERM was received: /readyz answers 503 so no new traffic is routed here. */
  isShuttingDown?: () => boolean;
  /** Where to find migration files for /readyz (tests point it elsewhere). */
  migrationsDir?: string;
}

/** Paths that are polled constantly by infrastructure; logged at debug level only. */
const PROBE_PATHS = new Set(['/healthz', '/readyz', '/metrics', '/health']);

export function createApp(pool: Pool, options: AppOptions): express.Express {
  const app = express();
  const metrics = options.metrics ?? createApiMetrics();
  const isShuttingDown = options.isShuttingDown ?? (() => false);

  // ── Request id, metrics and the access log, for EVERY request ──
  app.use((req, res, next) => {
    const requestId = requestIdFrom(req.header('x-request-id'));
    res.setHeader('X-Request-Id', requestId);
    // While shutting down, tell keep-alive clients not to reuse this connection.
    if (isShuttingDown()) res.setHeader('Connection', 'close');

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      // The route PATTERN ("/transfers"), never the raw URL: bounded label values.
      const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe(labels, seconds);
      const line = { request_id: requestId, ...labels, duration_ms: Math.round(seconds * 1000) };
      if (PROBE_PATHS.has(req.path)) logger.debug(line, 'request');
      else logger.info(line, 'request');
    });

    // Everything downstream (handlers, the ledger, outbox writes) runs inside this context.
    runWithRequestId(requestId, () => next());
  });

  // Webhooks are verified over the RAW request bytes, so their router (which
  // uses express.raw on its one route) must be mounted before express.json()
  // gets a chance to parse and discard the original bytes.
  app.use(
    webhooksRouter(pool, {
      webhookSecret: options.webhookSecret,
      metrics,
      ...(options.testHooks ? { testHooks: options.testHooks } : {}),
    }),
  );

  app.use(express.json());

  // ── Probes ──
  // Liveness: the process is up and its event loop answers. No dependencies on
  // purpose: a database outage must not make Kubernetes restart healthy pods.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'alive' });
  });

  // Readiness: should traffic be sent here right now?
  app.get('/readyz', async (_req, res) => {
    const report = await checkReadiness(pool, {
      shuttingDown: isShuttingDown(),
      ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {}),
    });
    res.status(report.ready ? 200 : 503).json(report);
  });

  // Kept from step 1: 200 only if the database answers a trivial query; 503 otherwise.
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'error', database: 'down' });
    }
  });

  app.get('/metrics', async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  const idempotency = { ...(options.keyClaimTimeoutMs !== undefined ? { keyClaimTimeoutMs: options.keyClaimTimeoutMs } : {}) };
  app.use(transfersRouter(pool, metrics, idempotency));
  app.use(topupsRouter(pool, metrics, idempotency));

  // Last resort. Express 5 routes rejected promises here automatically.
  const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
    if (isBodyParseError(err)) {
      res.status(400).json(errorBody('invalid_json', 'request body is not valid JSON'));
      return;
    }
    logger.error({ err }, 'unhandled error');
    res.status(500).json(errorBody('internal_error', 'something went wrong; it is safe to retry with the same key'));
  };
  app.use(errorHandler);

  return app;
}

function isBodyParseError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
}
