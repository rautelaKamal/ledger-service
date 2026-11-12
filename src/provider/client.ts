// The ledger's view of the payment provider: the one call we make to it.
// The mock provider (mock-provider/) implements the same shape in-process for
// tests and demos; HttpProviderClient talks to it (or a real one) over HTTP.

export interface CreatePaymentInput {
  amountPaise: bigint;
  currency: string;
  /** Our id for this top-up, echoed back in webhooks so an orphan payment can be traced. */
  reference: string;
}

export interface CreatePaymentResult {
  paymentId: string;
}

export interface ProviderClient {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
}

/** The provider was unreachable, too slow, or answered with an error. HTTP 502 for our caller. */
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountPaise: input.amountPaise.toString(), currency: input.currency, reference: input.reference }),
        // The call runs inside a database transaction that holds a connection and
        // (soon) row locks, so it must not be allowed to hang.
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
