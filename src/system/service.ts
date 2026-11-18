import type { Pool } from '../db.js';
import { recordRun, runReconciliation, type ReconcileReport } from '../reconcile/run.js';
import { LANE_PREDICATE, LANES, type Lane } from '../worker/lanes.js';

// Step 7d: what the web app's "under the hood" page reads and starts.
//
// Runs as ledger_reconciler (RECONCILER_DATABASE_URL): it may read the ledger,
// the outbox and the reconciliation history, append reconciliation runs, and
// record the start of an action. It cannot move money or touch the outbox.
// Served only on the API's INTERNAL port (see internal-server.ts).

export type SystemAction = 'reconcile' | 'chaos';

export const DEFAULT_COOLDOWN_SECONDS = 60;

export interface LaneStatus {
  lane: Lane;
  pending: number;
  /** Seconds the oldest pending row has been waiting, or null when none is pending. */
  oldestPendingSeconds: number | null;
  dead: number;
  sentLastHour: number;
}

export interface ReconciliationRunSummary {
  id: string;
  ranAt: string;
  ok: boolean;
  durationMs: number;
  problems: number;
  summary: Record<string, number>;
}

export interface SystemStatus {
  checkedAt: string;
  lanes: LaneStatus[];
  lastReconciliation: ReconciliationRunSummary | null;
  /** How many runs happened in the last 7 days: what the page says instead of "every night". */
  reconciliationRunsLast7Days: number;
  cooldownSeconds: number;
  /** Seconds until each action may start again (0 = now). */
  retryAfterSeconds: Record<SystemAction, number>;
}

export type Claim = { ok: true; startedAt: string } | { ok: false; retryAfterSeconds: number };

export interface SystemService {
  status(): Promise<SystemStatus>;
  /** Start an action if its cooldown allowed it. */
  claim(action: SystemAction): Promise<Claim>;
  /** claim('reconcile'), then run every check and record the run. */
  reconcileNow(): Promise<{ ok: true; run: ReconciliationRunSummary; report: ReconcileReport } | { ok: false; retryAfterSeconds: number }>;
}

export function createSystemService(pool: Pool, cooldownSeconds = DEFAULT_COOLDOWN_SECONDS): SystemService {
  async function retryAfter(action: SystemAction): Promise<number> {
    const { rows } = await pool.query<{ wait: number }>(
      `SELECT GREATEST(0, ceil(extract(epoch FROM (max(started_at) + make_interval(secs => $2) - now()))))::int AS wait
         FROM system_actions WHERE action = $1`,
      [action, cooldownSeconds],
    );
    return rows[0]?.wait ?? 0;
  }

  async function lastRun(): Promise<ReconciliationRunSummary | null> {
    const { rows } = await pool.query<{
      id: string;
      ran_at: string;
      ok: boolean;
      duration_ms: number;
      problems: number;
      summary: Record<string, number>;
    }>(
      `SELECT id::text, ran_at, ok, duration_ms, jsonb_array_length(problems) AS problems, summary
         FROM reconciliation_runs ORDER BY ran_at DESC, id DESC LIMIT 1`,
    );
    const r = rows[0];
    if (!r) return null;
    // The stored problem list is capped; the summary's counts are exact.
    const total = Object.values(r.summary).reduce((a, b) => a + b, 0);
    return { id: r.id, ranAt: r.ran_at, ok: r.ok, durationMs: r.duration_ms, problems: Math.max(total, r.problems), summary: r.summary };
  }

  return {
    async status() {
      const lanes: LaneStatus[] = [];
      for (const lane of LANES) {
        const { rows } = await pool.query<{ pending: number; oldest: number | null; dead: number; sent: number }>(
          `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                  round(extract(epoch FROM (now() - min(created_at) FILTER (WHERE status = 'pending'))))::int AS oldest,
                  count(*) FILTER (WHERE status = 'dead')::int AS dead,
                  count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '1 hour')::int AS sent
             FROM outbox WHERE ${LANE_PREDICATE[lane]}`,
        );
        const r = rows[0]!;
        lanes.push({ lane, pending: r.pending, oldestPendingSeconds: r.oldest, dead: r.dead, sentLastHour: r.sent });
      }
      const week = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM reconciliation_runs WHERE ran_at > now() - interval '7 days'`);
      return {
        checkedAt: new Date().toISOString(),
        lanes,
        lastReconciliation: await lastRun(),
        reconciliationRunsLast7Days: week.rows[0]!.n,
        cooldownSeconds,
        retryAfterSeconds: { reconcile: await retryAfter('reconcile'), chaos: await retryAfter('chaos') },
      };
    },

    async claim(action) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // One claimer per action at a time, across every API replica.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`system_actions:${action}`]);
        const { rows } = await client.query<{ wait: number }>(
          `SELECT GREATEST(0, ceil(extract(epoch FROM (max(started_at) + make_interval(secs => $2) - now()))))::int AS wait
             FROM system_actions WHERE action = $1`,
          [action, cooldownSeconds],
        );
        const wait = rows[0]?.wait ?? 0;
        if (wait > 0) {
          await client.query('ROLLBACK');
          return { ok: false, retryAfterSeconds: wait };
        }
        const inserted = await client.query<{ started_at: string }>(
          'INSERT INTO system_actions (action) VALUES ($1) RETURNING started_at',
          [action],
        );
        await client.query('COMMIT');
        return { ok: true, startedAt: inserted.rows[0]!.started_at };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async reconcileNow() {
      const claim = await this.claim('reconcile');
      if (!claim.ok) return claim;
      const report = await runReconciliation(pool);
      const id = await recordRun(pool, report);
      const problems = Object.values(report.summary).reduce((a, b) => a + b, 0);
      return {
        ok: true,
        report,
        run: { id: String(id), ranAt: report.ranAt, ok: report.ok, durationMs: report.durationMs, problems, summary: report.summary },
      };
    },
  };
}
