import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// API metrics. One Registry per app instance (tests create several apps in one
// process; the global default registry would reject duplicate names).
//
// LABELS ARE LOW-CARDINALITY: every label value comes from a small fixed set
// (route PATTERNS like "/transfers", status codes, our own result codes).
// Never an account id, an idempotency key, a request id or a raw URL: each
// distinct label value creates a new time series in Prometheus, forever.

export interface ApiMetrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  transfers: Counter<'result'>;
  topups: Counter<'result'>;
  idempotencyReplays: Counter<'route'>;
  idempotencyRejections: Counter<'route' | 'reason'>;
  webhookEvents: Counter<'result'>;
}

export function createApiMetrics(options: { defaultMetrics?: boolean } = {}): ApiMetrics {
  const registry = new Registry();
  if (options.defaultMetrics) collectDefaultMetrics({ register: registry, prefix: 'ledger_api_' });

  return {
    registry,
    httpRequests: new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests handled, by method, route pattern and status code.',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Time from request received to response finished.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    transfers: new Counter({
      name: 'ledger_transfers_total',
      help: 'POST /transfers outcomes (replays are counted separately, not here).',
      labelNames: ['result'],
      registers: [registry],
    }),
    topups: new Counter({
      name: 'ledger_topups_total',
      help: 'POST /topups outcomes (replays are counted separately, not here).',
      labelNames: ['result'],
      registers: [registry],
    }),
    idempotencyReplays: new Counter({
      name: 'idempotency_replays_total',
      help: 'Requests answered from a stored response (same Idempotency-Key, same request).',
      labelNames: ['route'],
      registers: [registry],
    }),
    idempotencyRejections: new Counter({
      name: 'idempotency_rejections_total',
      help: 'Requests refused because of their Idempotency-Key (reused for another request, or still in progress).',
      labelNames: ['route', 'reason'],
      registers: [registry],
    }),
    webhookEvents: new Counter({
      name: 'webhook_events_total',
      help: 'Provider webhooks by what the ledger did with them.',
      labelNames: ['result'],
      registers: [registry],
    }),
  };
}

/** Our result label for a stored/returned response: "created"/"accepted", or the error code. */
export function resultLabel(status: number, body: unknown): string {
  if (status === 201) return 'created';
  if (status === 202) return 'accepted';
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : `status_${status}`;
}
