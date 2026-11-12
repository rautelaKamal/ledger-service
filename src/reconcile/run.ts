import type { Pool } from '../db.js';
import {
  checkAccountBalances,
  checkOutbox,
  checkPostedTransactionsBalanced,
  checkStalePendingTopups,
  checkWebhookAnomalies,
  type CheckName,
  type Problem,
} from './checks.js';

export interface ReconcileOptions {
  /** A pending top-up older than this is stale. Default 24 h. */
  staleTopupAfterMs?: number;
  /** A pending outbox row older than this is stuck. Default 60 min. */
  outboxPendingAfterMs?: number;
  /** Keep at most this many problems per check in the stored run (the counts are always exact). */
  maxStoredProblemsPerCheck?: number;
}

export interface ReconcileReport {
  ok: boolean;
  ranAt: string;
  durationMs: number;
  /** Exact number of problems per check. */
  summary: Record<CheckName, number>;
  problems: Problem[];
}

export const DEFAULT_STALE_TOPUP_AFTER_MS = 24 * 60 * 60_000;
export const DEFAULT_OUTBOX_PENDING_AFTER_MS = 60 * 60_000;

/** Run every check (read-only) and build the report. Does not write anything. */
export async function runReconciliation(pool: Pool, options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const started = Date.now();
  const results: Problem[][] = [
    await checkAccountBalances(pool),
    await checkPostedTransactionsBalanced(pool),
    await checkStalePendingTopups(pool, options.staleTopupAfterMs ?? DEFAULT_STALE_TOPUP_AFTER_MS),
    await checkWebhookAnomalies(pool),
    await checkOutbox(pool, options.outboxPendingAfterMs ?? DEFAULT_OUTBOX_PENDING_AFTER_MS),
  ];
  const names: CheckName[] = ['account_balances', 'posted_transactions_balanced', 'stale_pending_topups', 'webhook_anomalies', 'outbox_problems'];
  const summary = Object.fromEntries(names.map((n, i) => [n, results[i]!.length])) as Record<CheckName, number>;
  const cap = options.maxStoredProblemsPerCheck ?? 100;
  const problems = results.flatMap((list) => list.slice(0, cap));
  return {
    ok: results.every((list) => list.length === 0),
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary,
    problems,
  };
}

/** The one write: an append-only record of this run (as ledger_reconciler). */
export async function recordRun(pool: Pool, report: ReconcileReport): Promise<bigint> {
  const { rows } = await pool.query<{ id: bigint }>(
    `INSERT INTO reconciliation_runs (ok, duration_ms, summary, problems)
     VALUES ($1, $2, $3::jsonb, $4::jsonb)
     RETURNING id`,
    [report.ok, report.durationMs, JSON.stringify(report.summary), JSON.stringify(report.problems)],
  );
  return rows[0]!.id;
}

export function formatReport(report: ReconcileReport): string {
  const lines = [`Reconciliation ${report.ok ? 'OK' : 'FAILED'} at ${report.ranAt} (${report.durationMs} ms)`];
  for (const [check, count] of Object.entries(report.summary)) {
    lines.push(`  ${count === 0 ? 'ok  ' : 'FAIL'} ${check}: ${count} problem(s)`);
  }
  for (const p of report.problems) lines.push(`    - [${p.check}] ${p.id}: ${p.detail}`);
  return lines.join('\n');
}
