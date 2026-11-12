// The worker's view of the payment provider: the one call we make to it.
// The mock provider (mock-provider/) implements the same shape in-process for
// tests and demos; HttpProviderClient talks to it (or a real one) over HTTP.

export interface CreatePaymentInput {
  amountPaise: bigint;
  currency: string;
  /** Our id for this top-up, echoed back in webhooks so an orphan payment can be traced. */
  reference: string;
  /**
   * The outbox worker may call us twice for the same top-up (at-least-once
   * delivery). The provider must return the SAME payment for the same key, so we
   * send the top-up id. Exactly what step 3 did for our own clients.
   */
  idempotencyKey: string;
}

export interface CreatePaymentResult {
  paymentId: string;
}

export interface ProviderClient {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
}

/** The provider was unreachable, too slow, or answered with an error. The outbox row is retried. */
export class ProviderError extends Error {
  override name = 'ProviderError';
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 3_000;

export class HttpProviderClient implements ProviderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
  ) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
        body: JSON.stringify({ amountPaise: input.amountPaise.toString(), currency: input.currency, reference: input.reference }),
        // The worker holds an outbox row lock while this runs; it must not hang.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`provider unreachable: ${(err as Error).name}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new ProviderError(`provider answered ${res.status} to POST /payments`);
    }
    const json = (await res.json()) as { paymentId?: unknown };
    if (typeof json.paymentId !== 'string' || json.paymentId.length === 0) {
      throw new ProviderError('provider response has no paymentId');
    }
    return { paymentId: json.paymentId };
  }
}
