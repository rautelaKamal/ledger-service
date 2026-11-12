import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// One request id per piece of work, available anywhere in its async call chain
// without passing it through every function. The HTTP layer starts a context per
// request; the outbox worker starts one per row, using the id that the original
// request stored in the row's payload. So one transfer can be followed in the
// logs from the HTTP request, through the outbox, to the notification it caused.

export interface WorkContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<WorkContext>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

// A client may send its own X-Request-Id (so its logs and ours share one id).
// We accept it only if it is short and boring: it ends up in logs and headers.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestIdFrom(incoming: string | undefined): string {
  return incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}
