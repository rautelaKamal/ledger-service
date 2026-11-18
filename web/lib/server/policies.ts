import 'server-only';

// Exact sections of the (fictional) policy documents in agent/policies/, quoted by
// the scripted demo answers. scripts/check-policy-excerpts.mjs fails CI if any of
// these drifts from the file it claims to quote.
export interface PolicyExcerpt {
  source: string;
  heading: string;
  text: string;
}

export const POLICIES = {
  refunds: {
    source: 'failed-top-up-refunds.md',
    heading: 'How long a refund takes',
    text: 'If money left your bank account or card for a top-up that then failed, the provider returns it. Refunds to UPI and bank accounts take 1 to 3 business days; refunds to cards take 5 to 7 business days, depending on the card issuer. The ledger does not hold the money at any point during a refund.',
  },
  pendingTopups: {
    source: 'pending-states.md',
    heading: 'Top-ups',
    text: 'A top-up starts pending and becomes posted when the provider confirms it, or failed when the provider reports a failure. A pending top-up is not part of your balance.',
  },
  duplicates: {
    source: 'duplicate-payments.md',
    heading: 'Why you never pay twice',
    text: 'Every transfer request carries an idempotency key. If a request is sent again with the same key, for example after a network timeout, the ledger returns the original result instead of moving money a second time.',
  },
} satisfies Record<string, PolicyExcerpt>;
