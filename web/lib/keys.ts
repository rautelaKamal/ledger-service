// Every Idempotency-Key the web forms send comes from here: one generator, one
// prefix per form, so any key in the ledger says where it came from
// ("web-transfer-…" from Send, "web-topup-…" from Top up). Works on the server
// (the first key, rendered with the page) and in the browser (a new key).
export type KeyFor = 'transfer' | 'topup';

export const KEY_PREFIX: Record<KeyFor, string> = { transfer: 'web-transfer-', topup: 'web-topup-' };

export function newKey(kind: KeyFor): string {
  return `${KEY_PREFIX[kind]}${globalThis.crypto.randomUUID()}`;
}
