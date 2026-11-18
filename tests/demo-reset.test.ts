// Step 7d: the demo reset deletes and re-seeds ONLY the demo clients. Anyone
// else's money (here an eval- client and a plain test client) is untouched, the
// append-only triggers are on again afterwards, and the ledger reconciles.

import { afterAll, beforeAll, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import { resetDemo } from '../src/demo/reset.js';
import { DEMO_CLIENTS, SEED_BALANCES, seedDemo } from '../src/demo/seed.js';
import { verifyDemo } from '../src/demo/verify.js';
import { runReconciliation } from '../src/reconcile/run.js';
import { PG, balanceOf, createAccount, fundAccount, withCommit } from './helpers.js';
import { postTransfer, startTestServer, type TestServer } from './http.js';
import { resetLedger } from './reset.js';

let owner: Pool;
let app: Pool;
let server: TestServer;

beforeAll(async () => {
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  app = createPool(process.env.DATABASE_URL!, { max: 3 });
  await resetLedger(owner);
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
  await Promise.all([owner.end(), app.end()]);
});

const demoSnapshot = () =>
  owner
    .query<{ n: number; total: string }>(`SELECT count(*)::int AS n, COALESCE(sum(balance_paise), 0)::text AS total FROM accounts WHERE owner_client_id = ANY($1)`, [[...DEMO_CLIENTS]])
    .then((r) => r.rows[0]!);

test('1. the reset brings the demo back to its seed and leaves every other client exactly as it was', async () => {
  // Someone else's money: an eval client with a transfer of their own.
  const evalA = await createAccount(app, 'user', 'INR', 'eval: asha', 'eval-asha');
  const evalB = await createAccount(app, 'user', 'INR', 'eval: bilal', 'eval-bilal');
  await fundAccount(owner, evalA, 50_000n);
  expect((await postTransfer(server.url, { key: 'reset-eval-1', clientId: 'eval-asha', body: { fromAccountId: evalA, toAccountId: evalB, amountPaise: '1200' } })).status).toBe(201);
  const others = await owner.query(`SELECT count(*)::int AS n FROM transactions`);

  await withCommit(owner, (c) => seedDemo(c));
  const seeded = await demoSnapshot();
  // The seed is deterministic: exactly the balances recorded in SEED_BALANCES.
  const byName = await owner.query<{ name: string; balance_paise: string }>(`SELECT name, balance_paise::text FROM accounts WHERE owner_client_id = ANY($1)`, [[...DEMO_CLIENTS]]);
  expect(Object.fromEntries(byName.rows.map((r) => [r.name, BigInt(r.balance_paise)]))).toEqual(SEED_BALANCES);
  expect(await verifyDemo(owner)).toEqual({ ok: true, problems: [] });

  // Demo activity: a transfer between demo people.
  const [meera] = (await owner.query<{ id: string }>(`SELECT id FROM accounts WHERE owner_client_id = 'demo-meera' ORDER BY created_at LIMIT 1`)).rows;
  const [kavya] = (await owner.query<{ id: string }>(`SELECT id FROM accounts WHERE owner_client_id = 'demo-kavya' LIMIT 1`)).rows;
  expect((await postTransfer(server.url, { key: 'reset-demo-1', clientId: 'demo-meera', body: { fromAccountId: meera!.id, toAccountId: kavya!.id, amountPaise: '123450' } })).status).toBe(201);
  // The check notices the drift, by name and amount.
  const drift = await verifyDemo(owner);
  expect(drift.ok).toBe(false);
  expect(drift.problems).toContain('Meera Iyer, Savings: 5611250 paise, the seed says 5734700');

  const client = await owner.connect();
  try {
    const r = await resetDemo(client);
    expect(r.accounts).toBe(12);
  } finally {
    client.release();
  }

  expect(await demoSnapshot()).toEqual(seeded); // the same seed again, nothing of the demo activity left
  expect((await verifyDemo(owner)).ok).toBe(true);
  expect(await balanceOf(owner, evalA)).toBe(50_000n - 1_200n); // other clients untouched
  expect(await balanceOf(owner, evalB)).toBe(1_200n);
  const evalRows = await owner.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE client_id = 'eval-asha'`);
  expect(evalRows.rows[0]).toEqual({ n: 1 });
  const demoKeys = await owner.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE client_id = ANY($1)`, [[...DEMO_CLIENTS]]);
  expect(demoKeys.rows[0]).toEqual({ n: 0 });
  expect((await owner.query(`SELECT count(*)::int AS n FROM transactions`)).rows[0]!.n).toBeGreaterThan(others.rows[0]!.n);

  expect((await runReconciliation(owner)).ok).toBe(true);
});

test('2. afterwards the ledger is append-only again: the triggers the reset lifted are back on', async () => {
  const { rows } = await owner.query<{ id: string }>(`SELECT id FROM entries LIMIT 1`);
  await expect(owner.query('DELETE FROM entries WHERE id = $1', [rows[0]!.id])).rejects.toMatchObject({ code: PG.RAISE_EXCEPTION });
  const disabled = await owner.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'`);
  expect(disabled.rows[0]).toEqual({ n: 0 });
});
