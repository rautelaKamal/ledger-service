import 'server-only';
import type { Account, BalanceDay, Limits, PassbookPage, SystemStatus, Topup, WireExchange } from '@/lib/types';
import { env } from './env';

// The ONLY code that talks to the ledger API. It runs on the web server and adds
// X-Client-Id itself; route handlers and server components call these functions,
// the browser never calls the ledger.

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly service: 'ledger' | 'ledger-internal' | 'provider' | 'assistant',
  ) {
    super(`${service} answered ${status}`);
  }
}

const TIMEOUT_MS = 8_000;

// A kept-alive connection can be closed by the server at the very moment it is
// reused ("socket hang up", ECONNRESET): the request never arrived, or its answer
// was lost. Reads are safe to repeat. Money-moving requests are too, but ONLY
// because they carry an Idempotency-Key: if the first attempt did reach the
// ledger, the retry gets the stored answer back (Idempotent-Replayed: true).
const RETRYABLE = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'UND_ERR_CLOSED']);
const MAX_ATTEMPTS = 3;

async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (i >= MAX_ATTEMPTS || !code || !RETRYABLE.has(code)) throw err;
    }
  }
}

async function call<T>(base: string, service: UpstreamError['service'], path: string, init: RequestInit & { clientId?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.clientId) headers.set('x-client-id', init.clientId);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await withRetry(() => fetch(`${base}${path}`, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) }));
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new UpstreamError(res.status, body, service);
  return body as T;
}

const ledger = <T>(path: string, init?: RequestInit & { clientId?: string }) => call<T>(env.LEDGER_API_URL, 'ledger', path, init);
const internal = <T>(path: string, init?: RequestInit) => call<T>(env.LEDGER_INTERNAL_URL, 'ledger-internal', path, init);

export const getAccounts = (clientId: string) => ledger<{ accounts: Account[] }>('/accounts', { clientId }).then((r) => r.accounts);
/** The limits the API enforces, read from the API: the forms never state one it does not. */
export const getLimits = () => ledger<Limits>('/limits');

export function getPassbook(clientId: string, accountId: string, cursor?: string, limit = 25): Promise<PassbookPage> {
  const q = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
  return ledger<PassbookPage>(`/accounts/${encodeURIComponent(accountId)}/transactions?${q}`, { clientId });
}

export const getBalanceHistory = (clientId: string, accountId: string, days = 30) =>
  ledger<{ days: BalanceDay[] }>(`/accounts/${encodeURIComponent(accountId)}/balance-history?days=${days}`, { clientId }).then((r) => r.days);

export const getTopup = (clientId: string, topupId: string) => ledger<Topup>(`/topups/${encodeURIComponent(topupId)}`, { clientId });

/**
 * A money-moving request, returned WITH its wire exchange so the page can show
 * the idempotency key, the status and the replay header. X-Client-Id is shown
 * as "added by the server" rather than its value.
 */
async function moneyRequest(path: '/transfers' | '/topups', clientId: string, idempotencyKey: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<WireExchange> {
  const started = performance.now();
  const res = await withRetry(() =>
    fetch(`${env.LEDGER_API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': clientId, 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
  const text = await res.text();
  const shown = ['idempotent-replayed', 'x-request-id', 'content-type'];
  return {
    request: {
      method: 'POST',
      path,
      headers: { 'Idempotency-Key': idempotencyKey, 'X-Client-Id': '(added by the web server)', 'Content-Type': 'application/json' },
      body,
    },
    response: {
      status: res.status,
      headers: Object.fromEntries([...res.headers].filter(([k]) => shown.includes(k))),
      body: text ? (JSON.parse(text) as unknown) : null,
      ms: Math.round(performance.now() - started),
    },
  };
}

export const postTransfer = (
  clientId: string,
  key: string,
  body: { fromAccountId: string; toAccountId: string; amountPaise: string; note?: string },
  timeoutMs?: number,
) => moneyRequest('/transfers', clientId, key, body, timeoutMs);

export const postTopup = (clientId: string, key: string, body: { accountId: string; amountPaise: string }) => moneyRequest('/topups', clientId, key, body);

export const getSystemStatus = () => internal<SystemStatus>('/system/status');

/** 429 (cooldown) comes back as an UpstreamError carrying retryAfterSeconds. */
export const reconcileNow = () => internal<{ run: SystemStatus['lastReconciliation']; problems: unknown[] }>('/system/reconcile', { method: 'POST' });
export const claimChaos = () => internal<{ startedAt: string }>('/system/chaos', { method: 'POST' });
export const chaosCheck = () => internal<{ run: NonNullable<SystemStatus['lastReconciliation']>; problems: unknown[] }>('/system/chaos/check', { method: 'POST' });

/** The demo's bank: tell the mock provider how the payment ends. */
export async function settlePayment(paymentId: string, outcome: 'succeed' | 'fail'): Promise<void> {
  await call(env.PROVIDER_URL, 'provider', `/payments/${encodeURIComponent(paymentId)}/${outcome}`, { method: 'POST', body: '{}' });
}

export function retryAfterOf(err: unknown): number | null {
  if (err instanceof UpstreamError && err.status === 429) {
    const n = (err.body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    return typeof n === 'number' ? n : null;
  }
  return null;
}
