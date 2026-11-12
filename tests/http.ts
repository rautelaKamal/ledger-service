import type { Server } from 'node:http';
import { createApp, type AppOptions } from '../src/app.js';
import type { Pool } from '../src/db.js';

/** Short key-claim timeout so the "duplicate gives up" test takes ~1 s, not 5 s. */
export const TEST_KEY_CLAIM_TIMEOUT_MS = 1_000;
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-not-for-production';

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Start the real Express app on a random free port. Uses Node's built-in fetch to talk to it. */
export async function startTestServer(pool: Pool, options: Partial<AppOptions> = {}): Promise<TestServer> {
  const app = createApp(pool, {
    keyClaimTimeoutMs: TEST_KEY_CLAIM_TIMEOUT_MS,
    webhookSecret: TEST_WEBHOOK_SECRET,
    ...options,
  });
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
