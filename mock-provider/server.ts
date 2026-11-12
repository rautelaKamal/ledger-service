// Local HTTP wrapper around MockProvider.
//
//   npm run provider           (reads PROVIDER_PORT, WEBHOOK_SECRET, LEDGER_WEBHOOK_URL from .env)
//
//   POST /payments               { amountPaise, currency, reference }  -> 201 { paymentId }
//   POST /payments/:id/succeed   { times?, delayMs? }                  -> 202, then webhooks
//   POST /payments/:id/fail      { times?, delayMs? }                  -> 202, then webhooks
//   GET  /payments/:id                                                 -> the payment
//
// Call /fail then /succeed to produce out-of-order events; use times: 5 to
// produce duplicates. Deliveries happen in the background with retries.
import express from 'express';
import { MockProvider } from './provider.js';

const port = Number(process.env.PROVIDER_PORT ?? 4100);
const secret = process.env.WEBHOOK_SECRET;
const webhookUrl = process.env.LEDGER_WEBHOOK_URL;
if (!secret || !webhookUrl) {
  console.error('WEBHOOK_SECRET and LEDGER_WEBHOOK_URL must be set (copy .env.example to .env)');
  process.exit(1);
}

const provider = new MockProvider({ secret, webhookUrl, log: (line) => console.log(`[provider] ${line}`) });
const app = express();
app.use(express.json());

app.post('/payments', (req, res) => {
  const { amountPaise, currency, reference } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof amountPaise !== 'string' || !/^[1-9][0-9]*$/.test(amountPaise) || typeof currency !== 'string' || typeof reference !== 'string') {
    res.status(400).json({ error: 'amountPaise (digit string), currency and reference are required' });
    return;
  }
  const payment = provider.createPayment({ amountPaise, currency, reference });
  console.log(`[provider] payment ${payment.id} created: ${amountPaise} ${currency} (ref ${reference})`);
  res.status(201).json({ paymentId: payment.id });
});

app.get('/payments/:id', (req, res) => {
  const payment = provider.getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'unknown payment' });
    return;
  }
  res.json(payment);
});

for (const outcome of ['succeeded', 'failed'] as const) {
  app.post(`/payments/:id/${outcome === 'succeeded' ? 'succeed' : 'fail'}`, (req, res) => {
    if (!provider.getPayment(req.params.id)) {
      res.status(404).json({ error: 'unknown payment' });
      return;
    }
    const { times, delayMs } = (req.body ?? {}) as { times?: number; delayMs?: number };
    const opts = { ...(times !== undefined ? { times } : {}), ...(delayMs !== undefined ? { delayMs } : {}) };
    // Fire and forget: the webhook goes out in the background, like a real provider.
    void provider
      .settle(req.params.id, outcome, opts)
      .then((reports) => console.log(`[provider] ${req.params.id} ${outcome}: ${reports.map((r) => r.attempts.map((a) => a.status).join('/')).join(', ')}`))
      .catch((err: unknown) => console.error('[provider] delivery error', err));
    res.status(202).json({ paymentId: req.params.id, outcome, times: times ?? 1 });
  });
}

app.listen(port, () => console.log(`mock provider listening on http://localhost:${port}, webhooks -> ${webhookUrl}`));
