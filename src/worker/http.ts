import { createServer, type Server } from 'node:http';
import type { Pool } from '../db.js';
import { checkReadiness } from '../readiness.js';
import type { WorkerMetrics } from './metrics.js';

// The worker has no API, but Kubernetes and Prometheus still need to ask it
// three things. A tiny node:http server answers them:
//   GET /healthz   alive?                          (always 200 while the process runs)
//   GET /readyz    database reachable, migrations up to date, not shutting down?
//   GET /metrics   Prometheus text format

export interface WorkerHttpOptions {
  pool: Pool;
  metrics: WorkerMetrics;
  port: number;
  isShuttingDown: () => boolean;
  migrationsDir?: string;
}

export async function startWorkerHttpServer(options: WorkerHttpOptions): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' }).end();
        return;
      }
      if (path === '/healthz') {
        json(res, 200, { status: 'alive' });
      } else if (path === '/readyz') {
        const report = await checkReadiness(options.pool, {
          shuttingDown: options.isShuttingDown(),
          ...(options.migrationsDir ? { migrationsDir: options.migrationsDir } : {}),
        });
        json(res, report.ready ? 200 : 503, report);
      } else if (path === '/metrics') {
        const body = await options.metrics.registry.metrics();
        res.writeHead(200, { 'content-type': options.metrics.registry.contentType }).end(body);
      } else {
        json(res, 404, { error: 'not found' });
      }
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  return server;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
