import { createServer, type Server } from 'node:http';
import type { Registry } from 'prom-client';

// /metrics on its OWN port (METRICS_PORT), separate from the API port.
//
// Why: the API port is what the public Service and any ingress expose. Metrics
// reveal internals (routes, error rates, memory, event-loop lag) that outsiders
// have no business reading. On a separate port, the public Service simply does
// not list it, and a NetworkPolicy lets only Prometheus reach it (step 6b).
//
// Plain node:http, no Express: one route, nothing else to configure or exploit.
export async function startMetricsServer(registry: Registry, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    registry
      .metrics()
      .then((body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
