// How much ONE request may move. This file is the only place the numbers live:
//
//   - the API enforces them: POST /topups and POST /transfers answer 400
//     amount_over_limit above them, before anything is stored under the
//     idempotency key (like any other invalid amount);
//   - GET /limits publishes them, and the web app's forms show and check them
//     from there, so the page never states a limit the API does not enforce.
//
// They are per request, not per day: a cap on what one mistyped amount can do.

/** One top-up: at most ₹1,00,000.00. */
export const TOPUP_MAX_PAISE = 1_00_000_00n;

/** One transfer: at most ₹2,00,000.00. */
export const TRANSFER_MAX_PAISE = 2_00_000_00n;

const GROUPING = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** 10000000n -> "₹1,00,000.00" (Indian grouping, never rounded). */
export function rupees(paise: bigint): string {
  return `₹${GROUPING.format(paise / 100n)}.${(paise % 100n).toString().padStart(2, '0')}`;
}

/** The 400 answer's message when `amountPaise` is above `maxPaise`, or null when it is within the limit. */
export function overLimit(kind: 'top-up' | 'transfer', amountPaise: bigint, maxPaise: bigint): string | null {
  if (amountPaise <= maxPaise) return null;
  return `one ${kind} can be at most ${rupees(maxPaise)}; this one is ${rupees(amountPaise)}`;
}
