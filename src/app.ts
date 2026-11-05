import express from 'express';
import type { Pool } from './db.js';

export function createApp(pool: Pool): express.Express {
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

  return app;
}
