// Local HTTP wrapper around MockProvider, on node:http with NO dependencies,
// so this folder can leave the repo (a container, a Lambda) on its own.
//
//   npm run provider     (reads PROVIDER_PORT, WEBHOOK_SECRET, LEDGER_WEBHOOK_URL)
//
//   POST /payments               { amountPaise, currency, reference }  -> 201 { paymentId }
//                                (Idempotency-Key header: same key -> same payment)
//   GET  /payments/:id                                                 -> the payment
//   GET  /payments?reference=X                                         -> payments for one of our top-ups
//   POST /payments/:id/succeed   { times?, delayMs? }                  -> 202, then webhooks
//   POST /payments/:id/fail      { times?, delayMs? }                  -> 202, then webhooks
//   POST /notifications          (from the ledger's outbox worker)      -> 200, dedupes by Outbox-Id
//   GET  /healthz                                                      -> 200
//
// Call /fail then /succeed to produce out-of-order events; use times: 5 to
// produce duplicates. Deliveries happen in the background with retries.
// Logs are JSON lines carrying the caller's X-Request-Id, so they join ours.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MockProvider, type PaymentOutcome } from './provider.js';
import { SinkStore } from './sink.js';

const port = Number(process.env.PROVIDER_PORT ?? 4100);
const secret = process.env.WEBHOOK_SECRET;
const webhookUrl = process.env.LEDGER_WEBHOOK_URL;
if (!secret || !webhookUrl) {
  console.error('WEBHOOK_SECRET and LEDGER_WEBHOOK_URL must be set (copy .env.example to .env)');
  process.exit(1);
}

function log(fields: Record<string, unknown>, msg: string): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), service: 'mock-provider', msg, ...fields }));
}

const provider = new MockProvider({ secret, webhookUrl, log: (line) => log({}, line) });
const sink = new SinkStore();

const MAX_BODY_BYTES = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function route(req: IncomingMessage, res: ServerResponse, requestId: string | undefined): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['payments', 'pay_x', 'succeed']
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'alive' });

  // ── Notification sink: the downstream consumer of our outbox events ──
  if (method === 'POST' && url.pathname === '/notifications') {
    const body = await readJson(req);
    const outboxId = (req.headers['outbox-id'] as string | undefined) ?? (typeof body.outboxId === 'string' ? body.outboxId : undefined);
    if (!outboxId) return send(res, 400, { error: 'Outbox-Id header is required' });
    const receipt = sink.record(outboxId, body);
    log({ request_id: requestId, outbox_id: outboxId, sequence: body.sequence, type: body.type, duplicate: receipt.duplicate, total: sink.count }, 'notification received');
    return send(res, 200, { received: true, duplicate: receipt.duplicate });
  }

  if (parts[0] !== 'payments') return send(res, 404, { error: 'not found' });

  // POST /payments
  if (method === 'POST' && parts.length === 1) {
    const { amountPaise, currency, reference } = await readJson(req);
    if (typeof amountPaise !== 'string' || !/^[1-9][0-9]*$/.test(amountPaise) || typeof currency !== 'string' || typeof reference !== 'string') {
      return send(res, 400, { error: 'amountPaise (digit string), currency and reference are required' });
    }
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const payment = provider.createPayment({ amountPaise, currency, reference, ...(idempotencyKey ? { idempotencyKey } : {}) });
    log({ request_id: requestId, payment_id: payment.id, reference, amount_paise: amountPaise, currency }, 'payment created');
    return send(res, 201, { paymentId: payment.id });
  }

  // GET /payments?reference=X
  if (method === 'GET' && parts.length === 1) {
    const reference = url.searchParams.get('reference');
    if (!reference) return send(res, 400, { error: 'reference query parameter is required' });
    return send(res, 200, provider.paymentsForReference(reference));
  }

  // GET /payments/:id
  if (method === 'GET' && parts.length === 2) {
    const payment = provider.getPayment(parts[1]!);
    return payment ? send(res, 200, payment) : send(res, 404, { error: 'unknown payment' });
  }

  // POST /payments/:id/succeed | /fail
  if (method === 'POST' && parts.length === 3 && (parts[2] === 'succeed' || parts[2] === 'fail')) {
    const paymentId = parts[1]!;
    if (!provider.getPayment(paymentId)) return send(res, 404, { error: 'unknown payment' });
    const outcome: PaymentOutcome = parts[2] === 'succeed' ? 'succeeded' : 'failed';
    const { times, delayMs } = await readJson(req);
    const opts = {
      ...(typeof times === 'number' ? { times } : {}),
      ...(typeof delayMs === 'number' ? { delayMs } : {}),
    };
    // Fire and forget: the webhook goes out in the background, like a real provider.
    void provider
      .settle(paymentId, outcome, opts)
      .then((reports) =>
        log({ request_id: requestId, payment_id: paymentId, outcome, deliveries: reports.map((r) => r.attempts.map((a) => a.status).join('/')) }, 'webhook delivered'),
      )
      .catch((err: unknown) => log({ request_id: requestId, payment_id: paymentId, error: String(err) }, 'webhook delivery error'));
    return send(res, 202, { paymentId, outcome, times: opts.times ?? 1 });
  }

  return send(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  const requestId = req.headers['x-request-id'] as string | undefined;
  route(req, res, requestId).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : 'error' });
  });
});

server.listen(port, () => log({ port, webhook_url: webhookUrl }, 'mock provider listening'));

// Exit promptly on SIGTERM (the container stop signal); in-flight webhooks are best-effort here.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log({ signal }, 'stopping');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
