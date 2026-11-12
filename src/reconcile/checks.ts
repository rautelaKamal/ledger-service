import type { Pool, PoolClient } from '../db.js';
import { findUnreconciledAccounts } from '../ledger/reconciliation.js';

// Every check is READ-ONLY and answers one question with a list of problems.
// An empty list means the check passed. Amounts are strings (never JS numbers).

export type CheckName =
  | 'account_balances'
  | 'posted_transactions_balanced'
  | 'stale_pending_topups'
  | 'webhook_anomalies'
  | 'outbox_problems';

export interface Problem {
  check: CheckName;
  /** The row the problem is about (account id, transaction id, event id, outbox id). */
  id: string;
  detail: string;
}

type Db = Pool | PoolClient;

/** Does every account's cached balance equal credits - debits of its posted entries? */
export async function checkAccountBalances(db: Db): Promise<Problem[]> {
  const rows = await findUnreconciledAccounts(db);
  return rows.map((r) => ({
    check: 'account_balances',
    id: r.account_id,
    detail: `"${r.account_name}": cached balance ${r.cached_paise} paise, entries say ${r.computed_paise}`,
  }));
}

/** Does every posted transaction have >= 2 entries and debits = credits per currency? */
export async function checkPostedTransactionsBalanced(db: Db): Promise<Problem[]> {
  const { rows } = await db.query<{ transaction_id: string; currency: string; debits: bigint; credits: bigint; entries: number }>(
    `SELECT t.id AS transaction_id,
            COALESCE(e.currency, '---') AS currency,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE e.direction = 'debit'),  0)::bigint AS debits,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE e.direction = 'credit'), 0)::bigint AS credits,
            count(e.id)::int AS entries
       FROM transactions t
       LEFT JOIN entries e ON e.transaction_id = t.id
      WHERE t.status = 'posted'
      GROUP BY t.id, e.currency
     HAVING count(e.id) < 2
         OR COALESCE(SUM(e.amount_paise) FILTER (WHERE e.direction = 'debit'),  0)
         <> COALESCE(SUM(e.amount_paise) FILTER (WHERE e.direction = 'credit'), 0)
      ORDER BY t.id`,
  );
  return rows.map((r) => ({
    check: 'posted_transactions_balanced',
    id: r.transaction_id,
    detail: `${r.entries} entries in ${r.currency}: debits ${r.debits} vs credits ${r.credits}`,
  }));
}

/** Top-ups still pending after `olderThanMs`: the provider never confirmed or failed them. */
export async function checkStalePendingTopups(db: Db, olderThanMs: number): Promise<Problem[]> {
  const { rows } = await db.query<{ id: string; age_seconds: number; amount_paise: bigint; provider_payment_id: string | null }>(
    `SELECT t.id, round(extract(epoch FROM (now() - t.created_at)))::int AS age_seconds,
            tp.amount_paise, tp.provider_payment_id
       FROM transactions t
       JOIN topups tp ON tp.transaction_id = t.id
      WHERE t.kind = 'topup' AND t.status = 'pending'
        AND t.created_at < now() - ($1::text || ' milliseconds')::interval
      ORDER BY t.created_at`,
    [String(olderThanMs)],
  );
  return rows.map((r) => ({
    check: 'stale_pending_topups',
    id: r.id,
    detail: `pending for ${r.age_seconds} s, ${r.amount_paise} paise, provider payment ${r.provider_payment_id ?? '(not yet created)'}`,
  }));
}

/** Webhooks we received but could not apply. Someone has to look at these. */
export async function checkWebhookAnomalies(db: Db): Promise<Problem[]> {
  const { rows } = await db.query<{ provider_event_id: string; result: string; result_detail: string | null; provider_payment_id: string }>(
    `SELECT provider_event_id, result, result_detail, provider_payment_id
       FROM webhook_events
      WHERE result IN ('anomaly_amount_mismatch', 'unmatched')
      ORDER BY received_at`,
  );
  return rows.map((r) => ({
    check: 'webhook_anomalies',
    id: r.provider_event_id,
    detail: `${r.result} for payment ${r.provider_payment_id}: ${r.result_detail ?? ''}`.trim(),
  }));
}

/** Outbox rows that died, or have been pending for longer than `pendingLongerThanMs`. */
export async function checkOutbox(db: Db, pendingLongerThanMs: number): Promise<Problem[]> {
  const { rows } = await db.query<{ id: bigint; type: string; status: string; attempts: number; last_error: string | null; age_seconds: number }>(
    `SELECT id, type, status, attempts, last_error,
            round(extract(epoch FROM (now() - created_at)))::int AS age_seconds
       FROM outbox
      WHERE status = 'dead'
         OR (status = 'pending' AND created_at < now() - ($1::text || ' milliseconds')::interval)
      ORDER BY created_at`,
    [String(pendingLongerThanMs)],
  );
  return rows.map((r) => ({
    check: 'outbox_problems',
    id: r.id.toString(),
    detail: `${r.type} is ${r.status} after ${r.attempts} attempt(s), age ${r.age_seconds} s${r.last_error ? `: ${r.last_error}` : ''}`,
  }));
}
