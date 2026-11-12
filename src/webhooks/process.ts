import type { Pool } from '../db.js';
import { failTopup, findSettlementAccount, postTopup } from '../ledger/topup.js';

/** A webhook that passed signature verification and basic shape validation. */
export interface ParsedWebhookEvent {
  id: string;
  type: string;
  data: {
    paymentId: string;
    amountPaise?: string | undefined;
    currency?: string | undefined;
  };
}

export type WebhookResult =
  | 'posted'
  | 'failed'
  | 'ignored_already_final'
  | 'ignored_unknown_type'
  | 'anomaly_amount_mismatch'
  | 'unmatched';

export type ProcessOutcome = { duplicate: true } | { duplicate: false; result: WebhookResult; detail: string | null };

export interface WebhookTestHooks {
  /** Test-only: runs just before COMMIT, so a test can force a failure after the writes. */
  beforeWebhookCommit?: () => Promise<void>;
}

interface PendingTopupRow {
  transaction_id: string;
  account_id: string;
  currency: string;
  amount_paise: bigint;
  status: string;
}

/**
 * Apply one webhook event to the ledger, exactly once.
 *
 * Everything happens in ONE database transaction:
 *   1. is this event id already recorded?           -> duplicate, do nothing, 200
 *   2. lock the top-up's transaction row FOR UPDATE   -> serialises events for one payment
 *   3. decide and apply (post / fail / ignore / anomaly / unmatched)
 *   4. INSERT the webhook_events row with the result; a conflict here means a
 *      concurrent duplicate won the race -> roll back our work, report duplicate
 *   5. COMMIT: the ledger change and the event record become visible together
 * Any unexpected error rolls everything back; the caller answers 500 and the
 * provider retries.
 */
export async function processWebhookEvent(
  pool: Pool,
  event: ParsedWebhookEvent,
  rawBody: string,
  hooks: WebhookTestHooks = {},
): Promise<ProcessOutcome> {
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('BEGIN');

    // 1. Seen before? (fast path; step 4 catches the race)
    const seen = await client.query('SELECT 1 FROM webhook_events WHERE provider_event_id = $1', [event.id]);
    if (seen.rowCount) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }

    // 2. Find and lock the top-up this payment belongs to.
    const { rows } = await client.query<PendingTopupRow>(
      `SELECT t.transaction_id, t.account_id, t.currency, t.amount_paise, tx.status
         FROM topups t
         JOIN transactions tx ON tx.id = t.transaction_id
        WHERE t.provider_payment_id = $1
          FOR UPDATE OF tx`,
      [event.data.paymentId],
    );
    const topup = rows[0];

    // 3. Decide.
    let result: WebhookResult;
    let detail: string | null = null;
    if (!topup) {
      // Unknown payment: acknowledge, keep the evidence, investigate on our side.
      // A 4xx/5xx would only make the provider retry something that can never match.
      result = 'unmatched';
      detail = `no top-up with provider_payment_id ${event.data.paymentId}`;
    } else if (event.type !== 'payment.succeeded' && event.type !== 'payment.failed') {
      result = 'ignored_unknown_type';
      detail = `event type ${event.type} is not handled`;
    } else if (topup.status !== 'pending') {
      // Late, duplicated-with-a-new-id, or out of order: the ledger already has
      // its answer for this top-up and must not change it.
      result = 'ignored_already_final';
      detail = `top-up is already ${topup.status}`;
    } else if (event.type === 'payment.failed') {
      await failTopup(client, topup.transaction_id);
      result = 'failed';
    } else if (
      event.data.amountPaise === undefined ||
      event.data.currency === undefined ||
      BigInt(event.data.amountPaise) !== topup.amount_paise ||
      event.data.currency !== topup.currency
    ) {
      // The provider confirmed something other than what we asked for. Never
      // credit what the webhook says; credit nothing and leave the top-up
      // pending for a human (a later reconciliation step flags stale ones).
      result = 'anomaly_amount_mismatch';
      detail =
        `expected ${topup.amount_paise} ${topup.currency}, ` +
        `webhook says ${event.data.amountPaise ?? '(missing)'} ${event.data.currency ?? '(missing)'}`;
    } else {
      const settlementAccountId = await findSettlementAccount(client, topup.currency);
      if (!settlementAccountId) {
        // Refused at top-up creation, so this is a real inconsistency: 500, retry.
        throw new Error(`no ${topup.currency} settlement account while posting top-up ${topup.transaction_id}`);
      }
      await postTopup(client, {
        transactionId: topup.transaction_id,
        accountId: topup.account_id,
        settlementAccountId,
        currency: topup.currency,
        amountPaise: topup.amount_paise,
      });
      result = 'posted';
    }

    // 4. Record the event with what we did. ON CONFLICT DO NOTHING: if a
    //    concurrent delivery of the same event id committed while we worked,
    //    our work must be thrown away (theirs already counted).
    const recorded = await client.query(
      `INSERT INTO webhook_events
         (provider_event_id, event_type, provider_payment_id, raw_body, result, result_detail, topup_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING 1`,
      [event.id, event.type, event.data.paymentId, rawBody, result, detail, topup?.transaction_id ?? null],
    );
    if (recorded.rowCount === 0) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }

    if (hooks.beforeWebhookCommit) await hooks.beforeWebhookCommit();

    // 5. All or nothing.
    await client.query('COMMIT');
    return { duplicate: false, result, detail };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      connectionBroken = true;
    }
    throw err;
  } finally {
    client.release(connectionBroken ? true : undefined);
  }
}
