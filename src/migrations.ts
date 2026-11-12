// Migration runner core (the CLI is scripts/migrate.ts).
//   * reads migrations/NNN_name.sql in filename order
//   * skips files already recorded in schema_migrations
//   * runs each new file in its OWN transaction, together with the row that
//     records it, so a file is either fully applied and recorded, or not at all
//   * holds a Postgres ADVISORY LOCK for the whole run, so two copies (several
//     pods starting at once, a deploy racing a manual run) can never migrate
//     at the same time: the second one waits, then finds nothing left to do
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { Pool, PoolClient } from './db.js';

/** migrations/ next to src/ (repo) or next to dist/src/ (container image). */
export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/**
 * The advisory lock key. Any 64-bit number works as long as every copy of the
 * runner uses the same one and nothing else in the database uses it.
 */
export const MIGRATION_LOCK_KEY = 727_201_406;

export interface RunMigrationsOptions {
  /** Directory of .sql files. Tests point this at a scratch directory. */
  dir?: string;
  /** Called with true while waiting for another runner's lock, false once acquired. */
  onLockWait?: (waiting: boolean) => void;
}

export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}

export async function runMigrations(connectionString: string, options: RunMigrationsOptions = {}): Promise<string[]> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  let locked = false;
  try {
    // Session-level lock: held across the per-file transactions below, released
    // in `finally` (or automatically if this process dies and its connection drops).
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK_KEY]);
    if (!got.rows[0]!.ok) {
      options.onLockWait?.(true);
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    }
    locked = true;
    options.onLockWait?.(false);

    // Under the lock, so two first-ever runs cannot race on CREATE TABLE either.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    // Read AFTER taking the lock: whatever a previous holder applied is now visible.
    const done = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const alreadyApplied = new Set(done.rows.map((r) => r.filename));

    for (const file of await listMigrationFiles(dir)) {
      if (alreadyApplied.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
      }
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

/**
 * Migration files on disk that the database has not recorded yet. Used by
 * /readyz: a process running newer code than the schema must not take traffic.
 * Reads only schema_migrations.filename (granted to the app and worker in 006).
 */
export async function pendingMigrations(db: Pool | PoolClient, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const { rows } = await db.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));
  return (await listMigrationFiles(dir)).filter((f) => !applied.has(f));
}
