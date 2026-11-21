// Is the demo exactly as the seed made it, and does the ledger reconcile?
// Run after any screenshot or Playwright run (and by `npm run demo:check`).
// Its reconciliation is RECORDED like any other run (reconciliation_runs), so
// what the web app says about the last reconciliation ("0 problems, checked at
// 17:42 IST") includes this check.
import type { Pool } from '../db.js';
import { TOPUP_MAX_PAISE, TRANSFER_MAX_PAISE } from '../limits.js';
import { recordRun, runReconciliation } from '../reconcile/run.js';
import { DEMO_CLIENTS, PAYEE_NOTES, SEED_BALANCES } from './seed.js';

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

  // The demo's history keeps the limits the forms state (src/limits.ts): no top-up
  // or transfer above them. Money an account already held arrives as its opening
  // balance (kind 'opening'), which is not a request and has no limit.
  const over = await pool.query<{ kind: string; name: string; amount: string }>(
    `SELECT t.kind, a.name, e.amount_paise::text AS amount
       FROM transactions t
       JOIN entries e ON e.transaction_id = t.id AND e.direction = 'credit'
       JOIN accounts a ON a.id = e.account_id
      WHERE a.owner_client_id = ANY($1)
        AND ((t.kind = 'topup' AND e.amount_paise > $2) OR (t.kind = 'transfer' AND e.amount_paise > $3))
     UNION ALL
     SELECT 'topup', a.name, u.amount_paise::text
       FROM topups u JOIN accounts a ON a.id = u.account_id
      WHERE a.owner_client_id = ANY($1) AND u.amount_paise > $2`,
    [[...DEMO_CLIENTS], TOPUP_MAX_PAISE.toString(), TRANSFER_MAX_PAISE.toString()],
  );
  for (const r of new Set(over.rows.map((r) => `${r.name}: a ${r.kind} of ${r.amount} paise, above the limit`))) problems.push(r);
  const opening = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM transactions t JOIN entries e ON e.transaction_id = t.id AND e.direction = 'credit'
       JOIN accounts a ON a.id = e.account_id
      WHERE t.kind = 'opening' AND t.status = 'posted' AND a.name = 'Arjun Rao, Shop'`,
  );
  if (opening.rows[0]!.n !== 1) problems.push(`Arjun Rao, Shop: ${opening.rows[0]!.n} opening balances, the seed has 1`);

  // Every payment to a shop carries a note that fits the shop (or none): no
  // electricity bill paid at the tea stall.
  const notes = await pool.query<{ shop: string; note: string }>(
    `SELECT DISTINCT a.name AS shop, t.note
       FROM transactions t JOIN entries e ON e.transaction_id = t.id AND e.direction = 'credit'
       JOIN accounts a ON a.id = e.account_id
      WHERE t.kind = 'transfer' AND a.owner_client_id = 'demo-merchants' AND t.note IS NOT NULL`,
  );
  for (const r of notes.rows) {
    const fits = PAYEE_NOTES[r.shop as keyof typeof PAYEE_NOTES];
    if (!fits?.includes(r.note)) problems.push(`${r.shop}: the note "${r.note}" does not fit this payee`);
  }

  const report = await runReconciliation(pool);
  await recordRun(pool, report);
  for (const [check, n] of Object.entries(report.summary)) if (n > 0) problems.push(`reconciliation ${check}: ${n} problem${n === 1 ? '' : 's'}`);
  return { ok: problems.length === 0, problems };
}
