import 'server-only';
import { ago, dayKey, shortDay, timeLabel } from '@/lib/dates';
import type { SystemStatus } from '@/lib/types';
import { env } from './env';

/**
 * What the UI may say about reconciliation, derived from what really happened in
 * THIS environment: the last recorded run (a "Run reconciliation now", a demo
 * check, the CronJob) and its time. A schedule is mentioned only where
 * RECONCILE_SCHEDULE says one exists (the k8s CronJob); compose has none.
 */
export function reconciliationSentence(status: SystemStatus | null, now = new Date()): { headline: string; detail: string } {
  const schedule = env.RECONCILE_SCHEDULE ? `A scheduled job also runs it ${env.RECONCILE_SCHEDULE}.` : 'Nothing runs it on a schedule in this environment.';
  if (!status) return { headline: 'Reconciliation status is not available here.', detail: 'The ledger’s internal port did not answer.' };
  const run = status.lastReconciliation;
  if (!run) return { headline: 'Reconciliation has not run here yet.', detail: schedule };
  const found = run.problems === 0 ? '0 problems' : `${run.problems} problem${run.problems === 1 ? '' : 's'}`;
  const day = dayKey(run.ranAt) === dayKey(now.toISOString()) ? '' : ` on ${shortDay(dayKey(run.ranAt))}`;
  return {
    headline: `Last reconciliation: ${found}, checked at ${timeLabel(run.ranAt)} IST${day}.`,
    detail: `That was ${ago(run.ranAt, now.getTime())}. ${schedule}`,
  };
}
