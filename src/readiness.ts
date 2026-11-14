import type { Pool } from './db.js';
import { MIGRATIONS_DIR, pendingMigrations } from './migrations.js';

// Liveness vs readiness (see STEP-06A-EXPLAINED):
//   /healthz  "is this process alive?"          -> restart it if not
//   /readyz   "should it receive work right now?" -> take it out of rotation if not
// A process whose database is down, or whose code expects migrations the
// database does not have yet, is alive but NOT ready.

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: 'up' | 'down';
    migrations: 'up_to_date' | 'pending' | 'unknown';
    shutdown: 'no' | 'in_progress';
  };
  pending?: string[];
}

export async function checkReadiness(
  pool: Pool,
  options: { migrationsDir?: string; shuttingDown?: boolean } = {},
): Promise<ReadinessReport> {
  const shutdown = options.shuttingDown ? 'in_progress' : 'no';
  try {
    await pool.query('SELECT 1');
  } catch {
    return { ready: false, checks: { database: 'down', migrations: 'unknown', shutdown } };
  }
  let pending: string[];
  try {
    pending = await pendingMigrations(pool, options.migrationsDir ?? MIGRATIONS_DIR);
  } catch {
    // schema_migrations missing or not readable: the database is not migrated (yet).
    return { ready: false, checks: { database: 'up', migrations: 'unknown', shutdown } };
  }
  const migrations = pending.length === 0 ? 'up_to_date' : 'pending';
  return {
    ready: migrations === 'up_to_date' && shutdown === 'no',
    checks: { database: 'up', migrations, shutdown },
    ...(pending.length ? { pending } : {}),
  };
}

export interface WaitUntilReadyOptions {
  migrationsDir?: string;
  /** How long to wait between checks. */
  intervalMs?: number;
  /** Return early (false) when this says so, e.g. SIGTERM arrived while waiting. */
  shouldStop?: () => boolean;
  /** Called after every check that was not ready, for logging. */
  onNotReady?: (report: ReadinessReport) => void;
}

/**
 * Block until the database is reachable and fully migrated. Resolves true when
 * it is, false if shouldStop() said to give up first.
 *
 * For processes that have no inbound traffic to gate (the worker): a freshly
 * deployed cluster runs the migrate Job and the workers at the same time, and a
 * worker that polls before the tables exist would crash on its first query.
 * Waiting here turns "crash, restart, crash" into one log line per check.
 */
export async function waitUntilReady(pool: Pool, options: WaitUntilReadyOptions = {}): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 2_000;
  for (;;) {
    const report = await checkReadiness(pool, options.migrationsDir ? { migrationsDir: options.migrationsDir } : {});
    if (report.ready) return true;
    options.onNotReady?.(report);
    if (options.shouldStop?.()) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (options.shouldStop?.()) return false;
  }
}
