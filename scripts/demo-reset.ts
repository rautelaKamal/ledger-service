// Start the web demo over:  npm run demo:reset
//
// Deletes the demo clients' rows (Meera, Arjun, Kavya, the shops, the chaos pair)
// and seeds them again, in one transaction (src/demo/reset.ts), then runs every
// reconciliation check: it fails unless the ledger is clean afterwards.
//
// Only ever against the demo/e2e database: it refuses any database not named
// ledger_e2e unless DEMO_RESET_ALLOW_DATABASE names it explicitly. Even then it
// touches only the demo clients (never eval- clients or anyone else).
import pg from 'pg';
import { resetDemo } from '../src/demo/reset.js';
import { runReconciliation } from '../src/reconcile/run.js';

const url = process.env.OWNER_DATABASE_URL;
if (!url) {
  console.error('OWNER_DATABASE_URL is not set (locally: npm run demo:reset reads .env.e2e.local)');
  process.exit(1);
}
const database = new URL(url).pathname.slice(1);
const allowed = process.env.DEMO_RESET_ALLOW_DATABASE ?? 'ledger_e2e';
if (database !== allowed) {
  console.error(`refusing to reset the demo in database "${database}": only ${allowed} (set DEMO_RESET_ALLOW_DATABASE=${database} to allow it)`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const client = await pool.connect();
  try {
    const r = await resetDemo(client);
    console.log(`${r.database}: removed ${r.accounts} demo accounts and ${r.transactions} transactions, seeded again:`);
    console.log(r.seeded.join('\n'));
  } finally {
    client.release();
  }
  const report = await runReconciliation(pool);
  const problems = Object.values(report.summary).reduce((a, b) => a + b, 0);
  console.log(`reconciliation: ${problems} problem${problems === 1 ? '' : 's'}`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await pool.end();
}
