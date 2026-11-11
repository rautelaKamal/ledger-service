import express from 'express';
import type { Pool } from './db.js';
import { errorBody } from './http/errors.js';
import { transfersRouter } from './http/transfers.js';
import type { IdempotentOptions } from './idempotency.js';

export function createApp(pool: Pool, options: IdempotentOptions = {}): express.Express {
  const app = express();
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

  app.use(transfersRouter(pool, options));

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
