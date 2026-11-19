// Start the web demo over:  npm run demo:reset
//
// Deletes the demo clients' rows (Meera, Arjun, Kavya, the shops, the chaos pair)
// and seeds them again, in one transaction (src/demo/reset.ts), then runs every
// reconciliation check: it fails unless the ledger is clean afterwards.
//
// Only ever against the two demo databases: ledger_demo (the one you browse;
// `npm run demo:reset` reads .env.demo.local) and ledger_e2e (the one Playwright
// writes to). Any other database is refused unless DEMO_RESET_ALLOW_DATABASE
// names it. Even then it touches only the demo clients (never eval- clients).
import pg from 'pg';
import { resetDemo } from '../src/demo/reset.js';
import { verifyDemo } from '../src/demo/verify.js';

const url = process.env.OWNER_DATABASE_URL;
if (!url) {
  console.error('OWNER_DATABASE_URL is not set (locally: npm run demo:reset reads .env.e2e.local)');
  process.exit(1);
}
const database = new URL(url).pathname.slice(1);
const allowed = ['ledger_demo', 'ledger_e2e', ...(process.env.DEMO_RESET_ALLOW_DATABASE ? [process.env.DEMO_RESET_ALLOW_DATABASE] : [])];
if (!allowed.includes(database)) {
  console.error(`refusing to reset the demo in database "${database}": only ${allowed.join(' or ')} (set DEMO_RESET_ALLOW_DATABASE=${database} to allow it)`);
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
  const check = await verifyDemo(pool);
  if (check.ok) console.log('check: every demo balance matches the seed; reconciliation 0 problems');
  else {
    console.error(`check FAILED:\n  ${check.problems.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
