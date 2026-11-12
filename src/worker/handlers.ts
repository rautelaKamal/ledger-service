import type { PoolClient } from '../db.js';
import type { OutboxPayloads, OutboxType } from '../outbox/enqueue.js';
import type { ProviderClient } from '../provider/client.js';
import type { NotificationSink } from './sinks.js';

/** One outbox row as the worker sees it. `id` is a bigint (BIGINT column). */
export interface OutboxRow {
  id: bigint;
  type: OutboxType;
  payload: unknown;
  attempts: number;
  created_at: Date;
}

/**
 * A handler performs ONE side effect for ONE row. It runs inside the worker's
 * per-row transaction on `client` (so its database writes commit with the
 * row's bookkeeping) and must be idempotent: it may run again after a crash.
 */
export type Handler = (row: OutboxRow, client: PoolClient) => Promise<void>;
export type Handlers = Record<OutboxType, Handler>;

export function createHandlers(deps: { provider: ProviderClient; sink: NotificationSink }): Handlers {
  const notify: Handler = async (row) => {
    await deps.sink.deliver({ outboxId: row.id.toString(), type: row.type, payload: row.payload, createdAt: row.created_at });
  };

  return {
    /**
     * Ask the provider for a payment and record its id on the top-up.
     * Idempotent in two layers: if the id is already recorded we do nothing;
     * if we crashed after the provider call, the retry sends the same
     * Idempotency-Key (the top-up id) and gets the same payment back.
     */
    'provider.create_payment': async (row, client) => {
      const p = row.payload as OutboxPayloads['provider.create_payment'];
      const { rows } = await client.query<{ provider_payment_id: string | null }>(
        'SELECT provider_payment_id FROM topups WHERE transaction_id = $1',
        [p.topupId],
      );
      if (!rows[0]) throw new Error(`top-up ${p.topupId} has no topups row`);
      if (rows[0].provider_payment_id !== null) return; // already recorded (a previous attempt got this far)

      const { paymentId } = await deps.provider.createPayment({
        amountPaise: BigInt(p.amountPaise),
        currency: p.currency,
        reference: p.topupId,
        idempotencyKey: p.topupId,
      });

      // The one UPDATE the trigger allows: NULL -> value. If a concurrent
      // attempt beat us to it with the same id, that is fine; a different id
      // means the provider broke its idempotency promise, and we refuse.
      const updated = await client.query(
        'UPDATE topups SET provider_payment_id = $2 WHERE transaction_id = $1 AND provider_payment_id IS NULL',
        [p.topupId, paymentId],
      );
      if (updated.rowCount === 0) {
        const now = await client.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM topups WHERE transaction_id = $1', [p.topupId]);
        if (now.rows[0]?.provider_payment_id !== paymentId) {
          throw new Error(`top-up ${p.topupId} already has payment ${now.rows[0]?.provider_payment_id}, provider returned ${paymentId}`);
        }
      }
    },
    'transfer.posted': notify,
    'topup.posted': notify,
    'topup.failed': notify,
  };
}
