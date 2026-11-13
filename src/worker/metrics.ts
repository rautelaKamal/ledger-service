import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Pool } from '../db.js';
import { logger } from '../logger.js';
import { LANES } from './lanes.js';
import type { RowOutcome } from './outbox.js';

// Worker metrics. Two kinds:
//   * EVENTS the worker observes itself (rows processed, how long handlers took):
//     counters and a histogram, updated as rows are handled.
//   * STATE that lives in the database (how far behind the outbox is, how many
//     rows are dead, what the last reconciliation said): gauges computed at
//     SCRAPE time with a query, so they are right even if several workers run
//     or this one just restarted.
// Labels come from small fixed sets: outbox types, outcomes, check names.

export interface WorkerMetrics {
  registry: Registry;
  rowsProcessed: Counter<'type' | 'outcome'>;
  handlerDuration: Histogram<'type' | 'outcome'>;
  /** Record one processed row (wire this to WorkerOptions.onOutcome). */
  record(outcome: RowOutcome, type: string, handlerSeconds: number): void;
}

const RECONCILIATION_CHECKS = [
  'account_balances',
  'posted_transactions_balanced',
  'stale_pending_topups',
  'webhook_anomalies',
  'outbox_problems',
] as const;

interface LatestRun {
  ok: boolean;
  ran_at: Date;
  summary: Record<string, number>;
}

export function createWorkerMetrics(pool: Pool, options: { defaultMetrics?: boolean } = {}): WorkerMetrics {
  const registry = new Registry();
  if (options.defaultMetrics) collectDefaultMetrics({ register: registry, prefix: 'ledger_worker_' });

  /** A failing scrape query must not break /metrics: keep the last value, log, move on. */
  const safely = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      logger.warn({ err, metric: what }, 'metric query failed');
    }
  };

  const rowsProcessed = new Counter({
    name: 'outbox_rows_processed_total',
    help: 'Outbox rows handled by this worker, by type and outcome (sent / retry / dead).',
    labelNames: ['type', 'outcome'],
    registers: [registry],
  });
  const handlerDuration = new Histogram({
    name: 'outbox_handler_duration_seconds',
    help: 'Time spent in the side effect (provider call, sink delivery) per row.',
    labelNames: ['type', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest outbox row that is due but not yet sent (0 when caught up).',
    registers: [registry],
    async collect() {
      await safely('outbox_lag_seconds', async () => {
        const { rows } = await pool.query<{ lag: number }>(
          `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(available_at))), 0)::float8 AS lag
             FROM outbox WHERE status = 'pending' AND available_at <= now()`,
        );
        this.set(Math.max(0, rows[0]!.lag));
      });
    },
  });
  new Gauge({
    name: 'outbox_pending_rows',
    help: 'Outbox rows not yet sent (including ones waiting out a backoff).',
    registers: [registry],
    async collect() {
      await safely('outbox_pending_rows', async () => {
        const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending'`);
        this.set(rows[0]!.n);
      });
    },
  });
  new Gauge({
    name: 'outbox_dead_rows',
    help: 'Outbox rows that exhausted their attempts (dead letters). Should be 0.',
    registers: [registry],
    async collect() {
      await safely('outbox_dead_rows', async () => {
        const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE status = 'dead'`);
        this.set(rows[0]!.n);
      });
    },
  });

  // ── Per lane: commands (provider.*) and events (notifications) ──
  // Two label values only. One query per scrape, shared by both gauges.
  let laneCache: { at: number; rows: Promise<{ lane: string; pending: number; lag: number }[]> } | null = null;
  const laneStats = (): Promise<{ lane: string; pending: number; lag: number }[]> => {
    if (!laneCache || Date.now() - laneCache.at > 1_000) {
      laneCache = {
        at: Date.now(),
        rows: pool
          .query<{ lane: string; pending: number; lag: number }>(
            `SELECT CASE WHEN type LIKE 'provider.%' THEN 'commands' ELSE 'events' END AS lane,
                    count(*)::int AS pending,
                    COALESCE(EXTRACT(EPOCH FROM (now() - min(available_at) FILTER (WHERE available_at <= now()))), 0)::float8 AS lag
               FROM outbox WHERE status = 'pending'
              GROUP BY 1`,
          )
          .then((r) => r.rows),
      };
    }
    return laneCache.rows;
  };
  new Gauge({
    name: 'outbox_lane_lag_seconds',
    help: 'Per lane: age of the oldest row that is due but not yet sent (0 when caught up).',
    labelNames: ['lane'],
    registers: [registry],
    async collect() {
      await safely('outbox_lane_lag_seconds', async () => {
        const rows = await laneStats();
        for (const lane of LANES) this.set({ lane }, Math.max(0, rows.find((r) => r.lane === lane)?.lag ?? 0));
      });
    },
  });
  new Gauge({
    name: 'outbox_lane_pending_rows',
    help: 'Per lane: rows not yet sent (including ones waiting out a backoff).',
    labelNames: ['lane'],
    registers: [registry],
    async collect() {
      await safely('outbox_lane_pending_rows', async () => {
        const rows = await laneStats();
        for (const lane of LANES) this.set({ lane }, rows.find((r) => r.lane === lane)?.pending ?? 0);
      });
    },
  });

  // ── The last reconciliation run (written by the short-lived reconcile job) ──
  // One query per scrape, shared by the three gauges below.
  let cached: { at: number; run: Promise<LatestRun | null> } | null = null;
  const latestRun = (): Promise<LatestRun | null> => {
    if (!cached || Date.now() - cached.at > 1_000) {
      cached = {
        at: Date.now(),
        run: pool
          .query<LatestRun>('SELECT ok, ran_at, summary FROM reconciliation_runs ORDER BY id DESC LIMIT 1')
          .then((r) => r.rows[0] ?? null),
      };
    }
    return cached.run;
  };

  new Gauge({
    name: 'reconciliation_last_run_ok',
    help: '1 if the most recent reconciliation found no problems, 0 if it found some. Absent if it never ran.',
    registers: [registry],
    async collect() {
      await safely('reconciliation_last_run_ok', async () => {
        const run = await latestRun();
        // Never ran -> NO sample (not 0: 0 would mean "the last run found problems").
        // An unlabelled prom-client gauge starts at 0 and reset() returns it to 0,
        // so remove() is what makes it truly absent.
        if (run) this.set(run.ok ? 1 : 0);
        else this.remove();
      });
    },
  });
  new Gauge({
    name: 'reconciliation_last_run_problems',
    help: 'Problems found by the most recent reconciliation, per check.',
    labelNames: ['check'],
    registers: [registry],
    async collect() {
      await safely('reconciliation_last_run_problems', async () => {
        const run = await latestRun();
        this.reset();
        if (!run) return;
        for (const check of RECONCILIATION_CHECKS) this.set({ check }, Number(run.summary[check] ?? 0));
      });
    },
  });
  new Gauge({
    name: 'reconciliation_last_run_timestamp_seconds',
    help: 'When the most recent reconciliation ran (unix seconds). Alert if it gets old.',
    registers: [registry],
    async collect() {
      await safely('reconciliation_last_run_timestamp_seconds', async () => {
        const run = await latestRun();
        if (run) this.set(run.ran_at.getTime() / 1000);
        else this.remove();
      });
    },
  });

  return {
    registry,
    rowsProcessed,
    handlerDuration,
    record(outcome, type, handlerSeconds) {
      if (outcome.status === 'idle') return;
      rowsProcessed.inc({ type, outcome: outcome.status });
      handlerDuration.observe({ type, outcome: outcome.status }, handlerSeconds);
    },
  };
}
