import 'server-only';
import { sumPaise } from '@/lib/money';
import type { ReconciliationRun } from '@/lib/types';
import { CHAOS_CLIENT_ID } from './identity';
import { chaosCheck, claimChaos, getAccounts, postTransfer, retryAfterOf } from './ledger';

export const CHAOS_TRANSFERS = 200;
const AMOUNT_PAISE = '100'; // ₹1.00 each way
// All 200 lock the same two rows, so the ledger serves them one after another: the
// last answer can take seconds. Wait long enough to hear every one of them.
const REQUEST_TIMEOUT_MS = 30_000;

export type ChaosResult =
  | { ok: false; retryAfterSeconds: number }
  | {
      ok: true;
      startedAt: string;
      transfers: number;
      statuses: Record<string, number>;
      p50Ms: number;
      p95Ms: number;
      wallMs: number;
      pairBefore: string;
      pairAfter: string;
      reconciliation: ReconciliationRun;
    };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/**
 * 200 transfers at once, half A to B and half B to A, through the PUBLIC API like
 * real clients, all fighting over the same two account rows. Then reconciliation.
 * The pair's combined balance must not change (every rupee that left one arrived
 * in the other), and reconciliation must find nothing. Once per cooldown (the API
 * decides, in the database, across every replica).
 */
export async function runChaos(): Promise<ChaosResult> {
  let startedAt: string;
  try {
    startedAt = (await claimChaos()).startedAt;
  } catch (err) {
    const wait = retryAfterOf(err);
    if (wait !== null) return { ok: false, retryAfterSeconds: wait };
    throw err;
  }

  const accounts = await getAccounts(CHAOS_CLIENT_ID);
  const [a, b] = accounts;
  if (!a || !b) throw new Error('the chaos accounts are missing: run the demo seed');
  const pairBefore = sumPaise([a.balancePaise, b.balancePaise]);

  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: CHAOS_TRANSFERS }, async (_, i) => {
      const [from, to] = i % 2 === 0 ? [a.id, b.id] : [b.id, a.id];
      try {
        const ex = await postTransfer(CHAOS_CLIENT_ID, `chaos-${startedAt}-${i}`, { fromAccountId: from, toAccountId: to, amountPaise: AMOUNT_PAISE }, REQUEST_TIMEOUT_MS);
        // A replay here means a dropped connection was retried with the same key and
        // the ledger answered from its record: counted apart, never as a second transfer.
        const replayed = ex.response.headers['idempotent-replayed'] === 'true';
        return { status: `${ex.response.status}${replayed ? ' replayed' : ''}`, ms: ex.response.ms };
      } catch (err) {
        // Not "failed": the ledger may still have posted it. The pair's total says what happened.
        const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
        return { status: cause === 'TimeoutError' ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : `no answer (${cause})`, ms: performance.now() - t0 };
      }
    }),
  );
  const wallMs = Math.round(performance.now() - t0);

  const after = await getAccounts(CHAOS_CLIENT_ID);
  const pairAfter = sumPaise(after.filter((x) => x.id === a.id || x.id === b.id).map((x) => x.balancePaise));
  const statuses: Record<string, number> = {};
  for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  const ms = results.map((r) => r.ms).sort((x, y) => x - y);
  const { run } = await chaosCheck();

  return {
    ok: true,
    startedAt,
    transfers: CHAOS_TRANSFERS,
    statuses,
    p50Ms: Math.round(percentile(ms, 50)),
    p95Ms: Math.round(percentile(ms, 95)),
    wallMs,
    pairBefore: pairBefore.toString(),
    pairAfter: pairAfter.toString(),
    reconciliation: run,
  };
}
