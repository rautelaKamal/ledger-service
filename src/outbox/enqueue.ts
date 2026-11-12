import type { PoolClient } from '../db.js';

/** The kinds of work the outbox carries. Must match the CHECK in migration 005. */
export type OutboxType = 'provider.create_payment' | 'transfer.posted' | 'topup.posted' | 'topup.failed';

export interface OutboxPayloads {
  'provider.create_payment': { topupId: string; accountId: string; currency: string; amountPaise: string };
  'transfer.posted': { transactionId: string; fromAccountId: string; toAccountId: string; currency: string; amountPaise: string };
  'topup.posted': { topupId: string; accountId: string; currency: string; amountPaise: string; providerPaymentId: string; webhookEventId: string };
  'topup.failed': { topupId: string; accountId: string; currency: string; amountPaise: string; providerPaymentId: string; webhookEventId: string };
}

/**
 * Queue a side effect IN THE CALLER'S TRANSACTION.
 *
 * This is the whole trick of the outbox pattern: the row commits or rolls back
 * together with the ledger change it describes, so there is no moment where the
 * change exists without its side effect queued, or the side effect is queued for
 * a change that never happened. The worker performs it later, outside any
 * ledger transaction. Amounts travel as strings (never JS numbers).
 */
export async function enqueueOutbox<T extends OutboxType>(client: PoolClient, type: T, payload: OutboxPayloads[T]): Promise<void> {
  await client.query(`INSERT INTO outbox (type, payload) VALUES ($1, $2::jsonb)`, [type, JSON.stringify(payload)]);
}
