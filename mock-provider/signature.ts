import { createHmac } from 'node:crypto';

// The provider's side of the contract. Deliberately a separate copy from the
// ledger's verifier: this folder must stay self-contained so it can move out of
// the repo (e.g. to a Lambda) without dragging the ledger's code along.
//
//   Provider-Signature: t=<unix seconds>,v1=<hex>
//   v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
export function signWebhook(secret: string, rawBody: string, timestampSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}
