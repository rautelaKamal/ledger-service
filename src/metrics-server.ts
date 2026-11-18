import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Registry } from 'prom-client';
import { logger } from './logger.js';
import type { SystemService } from './system/service.js';

// The API's INTERNAL port (METRICS_PORT), separate from the public API port.
//
// Why: the API port is what the public Service and any ingress expose. Metrics
// reveal internals (routes, error rates, memory, event-loop lag) that outsiders
// have no business reading. On a separate port, the public Service simply does
// not list it, and a NetworkPolicy lets only Prometheus (and, since step 7d, the
// web app's server) reach it.
//
//   GET  /metrics          Prometheus
//   GET  /system/status    outbox lanes, last reconciliation, cooldowns   (step 7d)
//   POST /system/reconcile run every check now, at most once per cooldown (step 7d)
//   POST /system/chaos     claim the chaos test's slot, once per cooldown  (step 7d)
//
// The /system routes exist only when a SystemService is given (it needs
// RECONCILER_DATABASE_URL); without one they answer 503 and say why.
//
// Plain node:http, no Express: a handful of routes, nothing else to configure or exploit.
export async function startMetricsServer(registry: Registry, port: number, system?: SystemService): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req, res, registry, system).catch((err: unknown) => {
      logger.error({ err }, 'internal server error');
      if (!res.headersSent) json(res, 500, { error: { code: 'internal_error', message: 'something went wrong' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function cooldown(res: ServerResponse, action: string, retryAfterSeconds: number): void {
  json(
    res,
    429,
    { error: { code: 'cooldown', message: `${action} can run once a minute; try again in ${retryAfterSeconds} s` }, retryAfterSeconds },
    { 'retry-after': String(retryAfterSeconds) },
  );
}

async function handle(req: IncomingMessage, res: ServerResponse, registry: Registry, system?: SystemService): Promise<void> {
  const path = (req.url ?? '/').split('?')[0];
  const route = `${req.method} ${path}`;

  if (route === 'GET /metrics') {
    res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
    return;
  }
  if (!['GET /system/status', 'POST /system/reconcile', 'POST /system/chaos'].includes(route)) {
    json(res, 404, { error: 'not found' });
    return;
  }
  if (!system) {
    json(res, 503, { error: { code: 'not_configured', message: 'system routes need RECONCILER_DATABASE_URL on the API' } });
    return;
  }

  if (route === 'GET /system/status') {
    json(res, 200, await system.status());
  } else if (route === 'POST /system/reconcile') {
    const result = await system.reconcileNow();
    if (!result.ok) return cooldown(res, 'Reconciliation', result.retryAfterSeconds);
    json(res, 200, { run: result.run, problems: result.report.problems.slice(0, 20) });
  } else {
    // The chaos test itself runs in the web app (200 transfers through the PUBLIC
    // API, like real clients); this only hands out its slot, once per cooldown.
    const claim = await system.claim('chaos');
    if (!claim.ok) return cooldown(res, 'The chaos test', claim.retryAfterSeconds);
    json(res, 200, { startedAt: claim.startedAt });
  }
}
