// Is the demo exactly as the seed made it, and does the ledger reconcile?
// Run after any screenshot or Playwright run (and by `npm run demo:check`).
// Its reconciliation is RECORDED like any other run (reconciliation_runs), so
// what the web app says about the last reconciliation ("0 problems, checked at
// 17:42 IST") includes this check.
import type { Pool } from '../db.js';
import { recordRun, runReconciliation } from '../reconcile/run.js';
import { DEMO_CLIENTS, SEED_BALANCES } from './seed.js';

export interface DemoCheck {
  ok: boolean;
  problems: string[];
}

export async function verifyDemo(pool: Pool): Promise<DemoCheck> {
  const problems: string[] = [];
  const { rows } = await pool.query<{ name: string; balance_paise: string }>(
    `SELECT name, balance_paise::text FROM accounts WHERE owner_client_id = ANY($1)`,
    [[...DEMO_CLIENTS]],
  );
  const actual = new Map(rows.map((r) => [r.name, BigInt(r.balance_paise)]));
  for (const [name, expected] of Object.entries(SEED_BALANCES)) {
    const got = actual.get(name);
    if (got === undefined) problems.push(`${name}: missing`);
    else if (got !== expected) problems.push(`${name}: ${got} paise, the seed says ${expected}`);
  }
  for (const name of actual.keys()) if (!(name in SEED_BALANCES)) problems.push(`${name}: not in the seed`);

  const report = await runReconciliation(pool);
  await recordRun(pool, report);
  for (const [check, n] of Object.entries(report.summary)) if (n > 0) problems.push(`reconciliation ${check}: ${n} problem${n === 1 ? '' : 's'}`);
  return { ok: problems.length === 0, problems };
}
