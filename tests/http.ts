import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import type { Pool } from '../src/db.js';
import type { IdempotentOptions } from '../src/idempotency.js';

/** Short key-claim timeout so the "duplicate gives up" test takes ~1 s, not 5 s. */
export const TEST_KEY_CLAIM_TIMEOUT_MS = 1_000;

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Start the real Express app on a random free port. Uses Node's built-in fetch to talk to it. */
export async function startTestServer(
  pool: Pool,
  options: IdempotentOptions = { keyClaimTimeoutMs: TEST_KEY_CLAIM_TIMEOUT_MS },
): Promise<TestServer> {
  const app = createApp(pool, options);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export interface PostTransferOptions {
  key?: string | undefined;
  clientId?: string | undefined;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent verbatim (to test malformed JSON). Overrides `body`. */
  rawBody?: string;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  json: unknown;
}

export async function postTransfer(url: string, opts: PostTransferOptions): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key !== undefined) headers['idempotency-key'] = opts.key;
  if (opts.clientId !== undefined) headers['x-client-id'] = opts.clientId;
  const res = await fetch(`${url}/transfers`, {
    method: 'POST',
    headers,
    body: opts.rawBody ?? JSON.stringify(opts.body),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}
