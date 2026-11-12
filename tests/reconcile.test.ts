// Reconciliation: "how do you know your balances are correct right now?"
//
// Runs the checks as ledger_reconciler against a clean ledger, then breaks the
// ledger on purpose (as the owner, who can) and checks that every problem is
// listed and the process exits non-zero.

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MockProvider } from '../mock-provider/provider.js';
import { createPool, type Pool } from '../src/db.js';
import { transfer } from '../src/ledger/transfer.js';
import { recordRun, runReconciliation, type ReconcileReport } from '../src/reconcile/run.js';
import { createHandlers } from '../src/worker/handlers.js';
import { Worker } from '../src/worker/run.js';
import { MemorySink } from '../src/worker/sinks.js';
import { createAccount, fundAccount } from './helpers.js';
import { TEST_WEBHOOK_SECRET, startTestServer, type TestServer } from './http.js';
import { resetLedger } from './reset.js';
import { exitOf, spawnTs } from './spawn.js';

let app: Pool;
let owner: Pool;
let workerPool: Pool;
let reconciler: Pool; // ledger_reconciler
let server: TestServer;
let provider: MockProvider;

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: 5 });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  workerPool = createPool(process.env.WORKER_DATABASE_URL!, { max: 2 });
  reconciler = createPool(process.env.RECONCILER_DATABASE_URL!, { max: 2 });
  await resetLedger(owner);
  server = await startTestServer(app);
  provider = new MockProvider({ secret: TEST_WEBHOOK_SECRET, webhookUrl: `${server.url}/webhooks/provider` });
});

afterAll(async () => {
  await server.close();
  await app.end();
  await owner.end();
  await workerPool.end();
  await reconciler.end();
});

/** Run the real CLI as a child process; returns exit code, stdout and the JSON report. */
async function runCli(env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; report: ReconcileReport }> {
  const dir = await mkdtemp(join(tmpdir(), 'reconcile-'));
  const out = join(dir, 'report.json');
  const child = spawnTs('src/reconcile/main.ts', ['--out', out], env);
  let stdout = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stdout += d.toString()));
  const { code } = await exitOf(child);
  return { code, stdout, report: JSON.parse(await readFile(out, 'utf8')) as ReconcileReport };
}

async function postTopup(accountId: string): Promise<string> {
  const res = await fetch(`${server.url}/topups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': 'reconcile-client', 'idempotency-key': `key-${randomUUID()}` },
    body: JSON.stringify({ accountId, amountPaise: '5000' }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { topupId: string }).topupId;
}

describe('reconciliation', () => {
  test(
    '9. a clean ledger reconciles (exit 0); a bad balance, a stale top-up, an anomaly and a dead outbox row are each listed (exit 1)',
    async () => {
      // A busy but healthy ledger: a funded transfer, a confirmed top-up, outbox drained.
      const a = await createAccount(app, 'user');
      const b = await createAccount(app, 'user');
      await fundAccount(owner, a, 10_000n);
      await transfer(app, { fromAccountId: a, toAccountId: b, amountPaise: 2_500n });
      const worker = new Worker(
        workerPool,
        createHandlers({ provider: { createPayment: async (i) => ({ paymentId: provider.createPayment(i).id }) }, sink: new MemorySink() }),
      );
      const confirmed = await postTopup(a);
      await worker.tick();
      const { rows } = await owner.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM topups WHERE transaction_id = $1', [confirmed]);
      await provider.settle(rows[0]!.provider_payment_id, 'succeeded');
      await worker.tick();

      const clean = await runReconciliation(reconciler, { staleTopupAfterMs: 0, outboxPendingAfterMs: 0 });
      expect(clean.ok).toBe(true);
      expect(clean.problems).toEqual([]);
      expect(clean.summary).toEqual({ account_balances: 0, posted_transactions_balanced: 0, stale_pending_topups: 0, webhook_anomalies: 0, outbox_problems: 0 });
      const cleanRun = await runCli({ RECONCILE_STALE_TOPUP_HOURS: '24' });
      expect(cleanRun.code).toBe(0);
      expect(cleanRun.stdout).toContain('Reconciliation OK');
      expect(cleanRun.report.ok).toBe(true);
      const runId = await recordRun(reconciler, clean);
      expect(runId).toBeGreaterThan(0n);

      // Now break four things, each in a way the schema allows (the owner can).
      // (1) a wrong cached balance: the "known gap" from step 1
      await owner.query('UPDATE accounts SET balance_paise = balance_paise + 1 WHERE id = $1', [b]);
      // (2) a top-up the provider never confirmed
      const stale = await postTopup(a);
      await worker.tick();
      // (3) a webhook we could not match
      const ghost = provider.createPayment({ amountPaise: '1', currency: 'INR', reference: 'nobody', idempotencyKey: 'ghost' });
      await provider.settle(ghost.id, 'succeeded');
      // (4) a dead outbox row: an event whose sink keeps failing
      await app.query(`INSERT INTO outbox (type, payload) VALUES ('transfer.posted', '{"transactionId":"dead"}')`);
      const failing = new MemorySink();
      failing.failAlways = new Error('sink down');
      const deadly = new Worker(workerPool, createHandlers({ provider: { createPayment: async () => ({ paymentId: 'x' }) }, sink: failing }), { maxAttempts: 1 });
      await deadly.tick();
      const { rows: dead } = await owner.query<{ id: bigint }>(`SELECT id FROM outbox WHERE status = 'dead'`);
      expect(dead).toHaveLength(1);
      const deadId = dead[0]!.id.toString();

      const broken = await runReconciliation(reconciler, { staleTopupAfterMs: 0, outboxPendingAfterMs: 60_000 });
      expect(broken.ok).toBe(false);
      expect(broken.summary).toEqual({ account_balances: 1, posted_transactions_balanced: 0, stale_pending_topups: 1, webhook_anomalies: 1, outbox_problems: 1 });
      expect(broken.problems).toEqual(
        expect.arrayContaining([
          { check: 'account_balances', id: b, detail: expect.stringContaining('cached balance 2501 paise, entries say 2500') },
          { check: 'stale_pending_topups', id: stale, detail: expect.stringContaining('5000 paise') },
          { check: 'webhook_anomalies', id: expect.any(String), detail: expect.stringContaining(`unmatched for payment ${ghost.id}`) },
          { check: 'outbox_problems', id: deadId, detail: expect.stringContaining('transfer.posted is dead after 1 attempt(s)') },
        ]),
      );

      // The CLI: exit 1, the same four problems in the JSON report, one run row recorded.
      const runsBefore = (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM reconciliation_runs')).rows[0]!.n;
      const failed = await runCli({ RECONCILE_STALE_TOPUP_HOURS: '0.000001' });
      expect(failed.code).toBe(1);
      expect(failed.stdout).toContain('Reconciliation FAILED');
      expect(failed.stdout).toContain('FAIL account_balances: 1 problem(s)');
      expect(failed.report.ok).toBe(false);
      expect(failed.report.problems.map((p) => p.check).sort()).toEqual(['account_balances', 'outbox_problems', 'stale_pending_topups', 'webhook_anomalies']);
      const runsAfter = await owner.query<{ n: number; ok: boolean; problems: unknown[] }>(
        'SELECT count(*) OVER()::int AS n, ok, problems FROM reconciliation_runs ORDER BY id DESC LIMIT 1',
      );
      expect(runsAfter.rows[0]).toMatchObject({ n: runsBefore + 1, ok: false });
      expect(runsAfter.rows[0]!.problems).toHaveLength(4);

      // Repair the balance; the account check goes green again, the rest stay listed.
      await owner.query('UPDATE accounts SET balance_paise = balance_paise - 1 WHERE id = $1', [b]);
      const partly = await runReconciliation(reconciler, { staleTopupAfterMs: 0, outboxPendingAfterMs: 60_000 });
      expect(partly.summary.account_balances).toBe(0);
      expect(partly.ok).toBe(false);
    },
    30_000,
  );

  test('10. a posted transaction whose entries do not balance is detected', async () => {
    // Cannot happen through the API (deferred trigger); simulate what the check sees
    // by disabling the trigger as the owner, writing a one-legged posted transaction,
    // and re-enabling it. This is exactly the kind of corruption reconciliation exists for.
    const a = await createAccount(app, 'user');
    await owner.query('ALTER TABLE entries DISABLE TRIGGER entries_transaction_must_balance');
    await owner.query('ALTER TABLE transactions DISABLE TRIGGER transactions_status_change_rules');
    let txId = '';
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(`INSERT INTO transactions (kind) VALUES ('transfer') RETURNING id`);
      txId = rows[0]!.id;
      await client.query(`INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise) VALUES ($1, $2, 'INR', 'credit', 700)`, [txId, a]);
      await client.query(`UPDATE transactions SET status = 'posted', posted_at = now() WHERE id = $1`, [txId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      await owner.query('ALTER TABLE entries ENABLE TRIGGER entries_transaction_must_balance');
      await owner.query('ALTER TABLE transactions ENABLE TRIGGER transactions_status_change_rules');
    }

    const report = await runReconciliation(reconciler);
    expect(report.problems).toContainEqual({ check: 'posted_transactions_balanced', id: txId, detail: '1 entries in INR: debits 0 vs credits 700' });
    expect(report.problems).toContainEqual(expect.objectContaining({ check: 'account_balances', id: a }));
  });
});
