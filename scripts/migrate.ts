// Minimal migration runner.
//   * reads migrations/NNN_name.sql in filename order
//   * skips files already recorded in schema_migrations
//   * runs each new file in its OWN transaction, together with the row that
//     records it, so a file is either fully applied and recorded, or not at all
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export async function runMigrations(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const alreadyApplied = new Set(done.rows.map((r) => r.filename));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
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
    await client.end();
  }
  return applied;
}

// Run only when executed directly (`npm run migrate`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.OWNER_DATABASE_URL;
  if (!url) {
    console.error('OWNER_DATABASE_URL is not set (copy .env.example to .env)');
    process.exit(1);
  }
  const applied = await runMigrations(url);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply; database is up to date.');
}
