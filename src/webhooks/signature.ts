import { createHmac, timingSafeEqual } from 'node:crypto';

// Provider-Signature: t=<unix seconds>,v1=<hex>
//   v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
//
// Signing the TIMESTAMP together with the body means a captured webhook cannot
// be replayed later with a fresh timestamp: changing t changes the expected
// signature, and only the secret holder can produce the new one.

export const SIGNATURE_HEADER = 'provider-signature';
export const DEFAULT_MAX_AGE_SECONDS = 5 * 60;
export const DEFAULT_FUTURE_TOLERANCE_SECONDS = 30; // clock skew between two machines is normal

export type SignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'timestamp_too_old'
  | 'timestamp_in_future'
  | 'signature_mismatch';

export interface VerifyInput {
  secret: string;
  /** The exact bytes received. Never a re-serialised object: one reordered key breaks the HMAC. */
  rawBody: Buffer;
  header: string | undefined;
  nowSeconds?: number;
  maxAgeSeconds?: number;
  futureToleranceSeconds?: number;
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: SignatureFailure };

/** Compute the header value the provider must send. Shared with the mock provider's own copy. */
export function computeSignature(secret: string, timestampSeconds: number, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
}

export function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq === -1) return null;
    parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (!t || !v1 || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return null;
  return { t: Number(t), v1 };
}

export function verifyWebhookSignature(input: VerifyInput): VerifyResult {
  if (!input.header) return { ok: false, reason: 'missing_header' };
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { ok: false, reason: 'malformed_header' };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const futureTolerance = input.futureToleranceSeconds ?? DEFAULT_FUTURE_TOLERANCE_SECONDS;
  if (now - parsed.t > maxAge) return { ok: false, reason: 'timestamp_too_old' };
  if (parsed.t - now > futureTolerance) return { ok: false, reason: 'timestamp_in_future' };

  const expected = Buffer.from(computeSignature(input.secret, parsed.t, input.rawBody), 'hex');
  const given = Buffer.from(parsed.v1, 'hex');
  // timingSafeEqual throws on different lengths, and a plain `===` would leak,
  // byte by byte, how much of a guess was right. Lengths are equal here by the
  // regex above, but we keep the guard so a future format change cannot throw.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true, timestamp: parsed.t };
}
