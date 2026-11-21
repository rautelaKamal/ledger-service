// Is the demo exactly as the seed made it, and does the whole ledger reconcile?
//   npm run demo:check            (the browsable demo, ledger_demo)
// Playwright runs the same check on ledger_e2e after every run.
import pg from 'pg';
import { verifyDemo } from '../src/demo/verify.js';

const url = process.env.OWNER_DATABASE_URL;
if (!url) {
  console.error('OWNER_DATABASE_URL is not set');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const check = await verifyDemo(pool);
  const db = new URL(url).pathname.slice(1);
  if (check.ok) console.log(`${db}: every demo balance matches the seed; reconciliation 0 problems`);
  else {
    console.error(`${db}: the demo is NOT as seeded:\n  ${check.problems.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
