import express from 'express';
import type { Pool } from './db.js';
import { errorBody } from './http/errors.js';
import { topupsRouter } from './http/topups.js';
import { transfersRouter } from './http/transfers.js';
import { webhooksRouter } from './http/webhooks.js';
import type { IdempotentOptions } from './idempotency.js';
import type { WebhookTestHooks } from './webhooks/process.js';

export interface AppOptions extends IdempotentOptions {
  /** Shared secret the provider signs webhooks with (WEBHOOK_SECRET). */
  webhookSecret: string;
  /** Test-only fault injection. Only reachable through this option: never env, never a request. */
  testHooks?: WebhookTestHooks;
}

export function createApp(pool: Pool, options: AppOptions): express.Express {
  const app = express();

  // Webhooks are verified over the RAW request bytes, so their router (which
  // uses express.raw on its one route) must be mounted before express.json()
  // gets a chance to parse and discard the original bytes.
  app.use(
    webhooksRouter(pool, {
      webhookSecret: options.webhookSecret,
      ...(options.testHooks ? { testHooks: options.testHooks } : {}),
    }),
  );

  app.use(express.json());

  // 200 only if the database answers a trivial query; 503 otherwise.
  // A load balancer / Kubernetes uses this to decide whether to send traffic here.
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'error', database: 'down' });
    }
  });

  const idempotency = { ...(options.keyClaimTimeoutMs !== undefined ? { keyClaimTimeoutMs: options.keyClaimTimeoutMs } : {}) };
  app.use(transfersRouter(pool, idempotency));
  app.use(topupsRouter(pool, idempotency));

  // Last resort. Express 5 routes rejected promises here automatically.
  const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
    if (isBodyParseError(err)) {
      res.status(400).json(errorBody('invalid_json', 'request body is not valid JSON'));
      return;
    }
    console.error(err);
    res.status(500).json(errorBody('internal_error', 'something went wrong; it is safe to retry with the same key'));
  };
  app.use(errorHandler);

  return app;
}

function isBodyParseError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
}
