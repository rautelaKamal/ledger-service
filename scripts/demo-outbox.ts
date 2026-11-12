// Demo: the transactional outbox surviving a crash.
//
//   npm run demo:outbox        (needs the dev database up, roles created, migrated)
//
// 1. POST /topups queues 'provider.create_payment' and returns 202 at once.
// 2. The worker calls the provider and is "killed" right after (before it can
//    record anything): the provider has a payment, we have no paymentId.
// 3. A fresh worker retries the same row. Same Idempotency-Key -> same payment.
// 4. The provider confirms; the webhook posts the top-up and queues 'topup.posted'.
// 5. The worker delivers that event to the sink. Then reconciliation runs.
//
// Everything runs in this process against the DEV database. The account is
// named "demo-outbox <timestamp>"; entries are append-only, so the rows stay.
import { randomUUID } from 'node:crypto';
import { MockProvider } from '../mock-provider/provider.js';
import { createApp } from '../src/app.js';
import { createPool, type Pool } from '../src/db.js';
import { formatReport, runReconciliation } from '../src/reconcile/run.js';
import { createHandlers } from '../src/worker/handlers.js';
import { Worker } from '../src/worker/run.js';
import { MemorySink } from '../src/worker/sinks.js';

const RUN_TAG = `demo-outbox ${new Date().toISOString()}`;
const SECRET = process.env.WEBHOOK_SECRET ?? 'demo-webhook-secret-not-for-production';

const rupees = (paise: bigint): string => `₹${(Number(paise) / 100).toFixed(2)}`;

async function balance(pool: Pool, id: string): Promise<bigint> {
  const { rows } = await pool.query<{ balance_paise: bigint }>('SELECT balance_paise FROM accounts WHERE id = $1', [id]);
  return rows[0]!.balance_paise;
}

async function main(): Promise<void> {
  const urls = {
    app: process.env.DATABASE_URL,
    owner: process.env.OWNER_DATABASE_URL,
    worker: process.env.WORKER_DATABASE_URL,
    reconciler: process.env.RECONCILER_DATABASE_URL,
  };
  if (!urls.app || !urls.owner || !urls.worker || !urls.reconciler) {
    console.error('DATABASE_URL, OWNER_DATABASE_URL, WORKER_DATABASE_URL and RECONCILER_DATABASE_URL must be set (see .env.example)');
    process.exit(1);
  }
  const app = createPool(urls.app);
  const owner = createPool(urls.owner, { max: 2 });
  const workerPool = createPool(urls.worker, { max: 2 });
  const reconciler = createPool(urls.reconciler, { max: 2 });

  const provider = new MockProvider({ secret: SECRET, webhookUrl: 'set-below' });
  const sink = new MemorySink();
  const handlers = createHandlers({
    provider: { createPayment: async (input) => ({ paymentId: provider.createPayment(input).id }) },
    sink,
  });
  const server = createApp(app, { webhookSecret: SECRET }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  provider.webhookUrl = `${url}/webhooks/provider`;

  const outboxRow = async (where: string, params: unknown[]): Promise<string> => {
    const { rows } = await owner.query<{ id: bigint; type: string; status: string; attempts: number; last_error: string | null }>(
      `SELECT id, type, status, attempts, last_error FROM outbox WHERE ${where} ORDER BY id`,
      params,
    );
    return rows.map((r) => `#${r.id} ${r.type} -> ${r.status} (attempts ${r.attempts}${r.last_error ? `, last error: ${r.last_error}` : ''})`).join('\n      ');
  };

  try {
    const { rows } = await owner.query<{ id: string }>(`INSERT INTO accounts (name, kind, currency) VALUES ($1, 'user', 'INR') RETURNING id`, [RUN_TAG]);
    const user = rows[0]!.id;

    console.log('1. POST /topups for ₹250.00');
    const res = await fetch(`${url}/topups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'demo', 'idempotency-key': `topup-${randomUUID()}` },
      body: JSON.stringify({ accountId: user, amountPaise: '25000' }),
    });
    const { topupId } = (await res.json()) as { topupId: string };
    console.log(`   -> ${res.status} topupId ${topupId.slice(0, 8)}…   (no provider call happened in the request)`);
    console.log(`   provider payments for this top-up: ${provider.paymentsForReference(topupId).length}`);
    console.log(`   outbox: ${await outboxRow(`payload->>'topupId' = $1`, [topupId])}\n`);

    console.log('2. Worker #1 picks the row, calls the provider, and is KILLED before it can commit');
    const doomed = new Worker(workerPool, handlers, {
      testHooks: {
        beforeCommit: async () => {
          throw new Error('kill -9 (simulated)');
        },
      },
    });
    await doomed.tick().catch((err: Error) => console.log(`   worker #1 died: ${err.message}`));
    const paymentId = await owner.query<{ provider_payment_id: string | null }>('SELECT provider_payment_id FROM topups WHERE transaction_id = $1', [topupId]);
    console.log(`   provider payments for this top-up: ${provider.paymentsForReference(topupId).length}   <- the side effect happened`);
    console.log(`   paymentId recorded in topups: ${paymentId.rows[0]!.provider_payment_id ?? 'NULL'}   <- but we never learned it`);
    console.log(`   outbox: ${await outboxRow(`payload->>'topupId' = $1`, [topupId])}   <- still pending: nothing is lost\n`);

    console.log('3. Worker #2 starts and retries the same row');
    const healthy = new Worker(workerPool, handlers, { log: (line) => console.log(`   [worker] ${line}`) });
    await healthy.tick();
    const recorded = await owner.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM topups WHERE transaction_id = $1', [topupId]);
    const payments = provider.paymentsForReference(topupId);
    console.log(`   provider payments for this top-up: ${payments.length}   <- same Idempotency-Key, same payment`);
    console.log(`   paymentId recorded in topups: ${recorded.rows[0]!.provider_payment_id}`);
    console.log(`   outbox: ${await outboxRow(`payload->>'topupId' = $1`, [topupId])}\n`);

    console.log('4. The provider confirms the payment (signed webhook)');
    const [report] = await provider.settle(payments[0]!.id, 'succeeded');
    console.log(`   webhook -> ${report!.attempts[0]!.status} ${JSON.stringify(report!.attempts[0]!.body)}`);
    console.log(`   balance now ${rupees(await balance(app, user))}`);
    console.log(`   outbox: ${await outboxRow(`type = 'topup.posted' AND payload->>'topupId' = $1`, [topupId])}\n`);

    console.log("5. The worker delivers 'topup.posted' to the notification sink");
    await healthy.tick();
    console.log(`   sink received: ${sink.received.map((e) => `${e.type} (outbox #${e.outboxId})`).join(', ')}`);
    console.log(`   outbox: ${await outboxRow(`payload->>'topupId' = $1`, [topupId])}\n`);

    console.log('6. Reconciliation');
    const reconciliation = await runReconciliation(reconciler, { outboxPendingAfterMs: 60_000 });
    console.log(
      formatReport(reconciliation)
        .split('\n')
        .map((l) => `   ${l}`)
        .join('\n'),
    );
    console.log(`\nFinal: ${rupees(await balance(app, user))} in the account, ONE payment at the provider, every outbox row sent.`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([app.end(), owner.end(), workerPool.end(), reconciler.end()]);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
