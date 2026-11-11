import pg from 'pg';
import { runMigrations } from '../scripts/migrate.js';
import { resetLedger } from './reset.js';
import { loadTestEnv } from './load-env.js';

export default async function setup(): Promise<void> {
  loadTestEnv();
  const ownerUrl = requireTestUrl('OWNER_DATABASE_URL');
  requireTestUrl('DATABASE_URL');

  // 1. Bring the test database schema up to date.
  await runMigrations(ownerUrl);

  // 2. Start from empty tables. We cannot clean up with DELETE (entries are
  //    append-only, enforced by a trigger), and the balance test must really
  //    COMMIT. TRUNCATE does not fire row-level DELETE triggers, and only the
  //    owner is allowed to TRUNCATE (ledger_app has no TRUNCATE privilege).
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await resetLedger(owner);
  } finally {
    await owner.end();
  }
}

// Safety net: this setup TRUNCATEs tables, so refuse to run against
// anything that is not clearly a test database.
function requireTestUrl(name: string): string {
  const url = process.env[name];
  if (!url) {
    throw new Error(`${name} is not set. Copy .env.test.example to .env.test.`);
  }
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`${name} points at database "${dbName}". Tests only run against a *_test database.`);
  }
  return url;
}
