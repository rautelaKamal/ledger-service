// A tiny stand-in for a payment provider (think Stripe/Razorpay), with no HTTP
// of its own: server.ts wraps it for local use, tests and demos drive it
// in-process. State is one in-memory Map, so it could become a Lambda by
// swapping the Map for a table.
import { randomUUID } from 'node:crypto';
import { signWebhook } from './signature.js';

export type PaymentOutcome = 'succeeded' | 'failed';

export interface ProviderPayment {
  id: string;
  amountPaise: string;
  currency: string;
  reference: string;
  status: 'created' | PaymentOutcome;
}

export interface WebhookEvent {
  id: string;
  type: `payment.${PaymentOutcome}` | string;
  created: number;
  data: { paymentId: string; amountPaise: string; currency: string; reference: string };
}

export interface DeliveryAttempt {
  status: number;
  body: unknown;
}

export interface DeliveryReport {
  eventId: string;
  attempts: DeliveryAttempt[];
  delivered: boolean;
}

export interface MockProviderOptions {
  secret: string;
  webhookUrl: string;
  /** Retry policy while the receiver answers non-2xx: at-least-once delivery. */
  retry?: { attempts: number; baseDelayMs: number };
  log?: (line: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MockProvider {
  private readonly payments = new Map<string, ProviderPayment>();
  readonly secret: string;
  webhookUrl: string;
  private readonly retry: { attempts: number; baseDelayMs: number };
  private readonly log: (line: string) => void;

  constructor(options: MockProviderOptions) {
    this.secret = options.secret;
    this.webhookUrl = options.webhookUrl;
    this.retry = options.retry ?? { attempts: 5, baseDelayMs: 200 };
    this.log = options.log ?? (() => {});
  }

  /** What the ledger calls (POST /payments). */
  createPayment(input: { amountPaise: string | bigint; currency: string; reference: string }): ProviderPayment {
    const payment: ProviderPayment = {
      id: `pay_${randomUUID().replace(/-/g, '')}`,
      amountPaise: input.amountPaise.toString(),
      currency: input.currency,
      reference: input.reference,
      status: 'created',
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  getPayment(paymentId: string): ProviderPayment | undefined {
    return this.payments.get(paymentId);
  }

  /** Build a new event (fresh id) describing an outcome. Does not send it. */
  buildEvent(paymentId: string, outcome: PaymentOutcome, overrides: Partial<WebhookEvent['data']> = {}): WebhookEvent {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error(`unknown payment ${paymentId}`);
    payment.status = outcome;
    return {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      type: `payment.${outcome}`,
      created: Math.floor(Date.now() / 1000),
      data: {
        paymentId: payment.id,
        amountPaise: payment.amountPaise,
        currency: payment.currency,
        reference: payment.reference,
        ...overrides,
      },
    };
  }

  /**
   * Settle a payment and deliver the webhook. `times > 1` re-sends the SAME
   * event (same id), which is what a real provider does when it believes a
   * delivery may have been lost. Returns one report per delivery.
   */
  async settle(
    paymentId: string,
    outcome: PaymentOutcome,
    options: { times?: number; delayMs?: number } = {},
  ): Promise<DeliveryReport[]> {
    const event = this.buildEvent(paymentId, outcome);
    const reports: DeliveryReport[] = [];
    for (let i = 0; i < (options.times ?? 1); i++) {
      if (options.delayMs) await sleep(options.delayMs);
      reports.push(await this.deliverWithRetry(event));
    }
    return reports;
  }

  /** One signed POST, no retry. `signWith` lets tests forge a bad signature. */
  async deliver(
    event: WebhookEvent,
    options: { timestamp?: number; signWith?: string; rawBody?: string } = {},
  ): Promise<DeliveryAttempt> {
    const rawBody = options.rawBody ?? JSON.stringify(event);
    const t = options.timestamp ?? Math.floor(Date.now() / 1000);
    const res = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'provider-signature': signWebhook(options.signWith ?? this.secret, rawBody, t),
      },
      body: rawBody,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON answer: keep the text */
    }
    return { status: res.status, body };
  }

  /** At-least-once delivery: retry with doubling backoff while the receiver answers non-2xx. */
  async deliverWithRetry(event: WebhookEvent): Promise<DeliveryReport> {
    const attempts: DeliveryAttempt[] = [];
    for (let n = 0; n < this.retry.attempts; n++) {
      if (n > 0) await sleep(this.retry.baseDelayMs * 2 ** (n - 1));
      let attempt: DeliveryAttempt;
      try {
        attempt = await this.deliver(event);
      } catch (err) {
        attempt = { status: 0, body: String(err) };
      }
      attempts.push(attempt);
      this.log(`webhook ${event.id} (${event.type}) attempt ${n + 1}: ${attempt.status}`);
      if (attempt.status >= 200 && attempt.status < 300) {
        return { eventId: event.id, attempts, delivered: true };
      }
    }
    return { eventId: event.id, attempts, delivered: false };
  }
}
