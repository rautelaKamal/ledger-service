// The migration runner's advisory lock: two copies can never migrate at once.
// (Kubernetes may start several pods, each running migrations on start-up.)
//
// These tests use scratch migration directories, so they never touch the real
// migrations. They clean up what they create (the probe table and its
// schema_migrations row) as the owner.

import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import { MIGRATION_LOCK_KEY, runMigrations } from '../src/migrations.js';

const ownerUrl = (): string => process.env.OWNER_DATABASE_URL!;
let owner: Pool;

beforeAll(() => {
  owner = createPool(ownerUrl(), { max: 2 });
});

afterAll(async () => {
  await owner.end();
});

describe('migration runner', () => {
  test('two runners started at the same moment apply a migration exactly once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    const table = `probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const file = `900_${table}.sql`;
    // Slow on purpose, so the two runs overlap: whoever is second arrives while
    // the first is still inside its transaction.
    await writeFile(join(dir, file), `CREATE TABLE ${table} (id int); SELECT pg_sleep(0.5);`);

    try {
      const results = await Promise.allSettled([runMigrations(ownerUrl(), { dir }), runMigrations(ownerUrl(), { dir })]);

      // Both succeed; one applied the file, the other waited and found nothing to do.
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const applied = results.map((r) => (r as PromiseFulfilledResult<string[]>).value).sort((a, b) => b.length - a.length);
      expect(applied).toEqual([[file], []]);
      const recorded = await owner.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      expect(recorded.rowCount).toBe(1);
    } finally {
      await owner.query(`DROP TABLE IF EXISTS ${table}`);
      await owner.query('DELETE FROM schema_migrations WHERE filename = $1', [file]);
    }
  });

  test('a runner waits while another holds the migration lock, and proceeds once it is released', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-empty-'));
    const holder = new pg.Client({ connectionString: ownerUrl() });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

      const waits: boolean[] = [];
      let finished = false;
      const run = runMigrations(ownerUrl(), { dir, onLockWait: (w) => waits.push(w) }).then((r) => {
        finished = true;
        return r;
      });

      await new Promise((r) => setTimeout(r, 400));
      expect(finished).toBe(false); // blocked behind the lock
      expect(waits).toEqual([true]); // and it said so

      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      expect(await run).toEqual([]);
      expect(waits).toEqual([true, false]);
    } finally {
      await holder.end(); // also releases the lock if an assertion failed above
    }
  });
});
