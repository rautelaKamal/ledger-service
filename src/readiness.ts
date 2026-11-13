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
