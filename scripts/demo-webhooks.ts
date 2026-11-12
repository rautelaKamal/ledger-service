// Demo: one top-up, confirmed by the provider FIVE times (duplicates), then
// one FORGED webhook. Watch what the ledger does with each.
//
//   npm run demo:webhooks        (needs the dev database up and migrated)
//
// Runs the real Express app and the mock provider in this process, against the
// DEV database. The account is named "demo-webhooks <timestamp>" so it never
// mixes with real dev data; entries are append-only, so the rows stay.
import { randomUUID } from 'node:crypto';
import { MockProvider } from '../mock-provider/provider.js';
import { signWebhook } from '../mock-provider/signature.js';
import { createApp } from '../src/app.js';
import { createPool, type Pool } from '../src/db.js';

const RUN_TAG = `demo-webhooks ${new Date().toISOString()}`;
const SECRET = process.env.WEBHOOK_SECRET ?? 'demo-webhook-secret-not-for-production';

function rupees(paise: bigint): string {
  return `₹${(Number(paise) / 100).toFixed(2)}`;
}

async function balance(pool: Pool, id: string): Promise<bigint> {
  const { rows } = await pool.query<{ balance_paise: bigint }>('SELECT balance_paise FROM accounts WHERE id = $1', [id]);
  return rows[0]!.balance_paise;
}

async function main(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.OWNER_DATABASE_URL;
  if (!appUrl || !ownerUrl) {
    console.error('DATABASE_URL and OWNER_DATABASE_URL must be set (copy .env.example to .env)');
    process.exit(1);
  }
  const app = createPool(appUrl);
  const owner = createPool(ownerUrl, { max: 2 });

  // Provider and ledger in one process, wired to each other.
  const provider = new MockProvider({
    secret: SECRET,
    webhookUrl: 'set-below',
    retry: { attempts: 3, baseDelayMs: 200 },
    log: (line) => console.log(`      [provider] ${line}`),
  });
  const server = createApp(app, {
    provider: { createPayment: async (input) => ({ paymentId: provider.createPayment(input).id }) },
    webhookSecret: SECRET,
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  provider.webhookUrl = `${url}/webhooks/provider`;

  try {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO accounts (name, kind, currency) VALUES ($1, 'user', 'INR') RETURNING id`,
      [RUN_TAG],
    );
    const user = rows[0]!.id;
    const bank = (await owner.query<{ id: string }>(`SELECT id FROM accounts WHERE kind = 'system' AND name = 'bank_settlement' AND currency = 'INR'`)).rows[0]!.id;
    console.log(`Account "${RUN_TAG}" starts with ${rupees(await balance(app, user))}. bank_settlement is at ${rupees(await balance(app, bank))}.\n`);

    // 1. The user asks to top up ₹250.
    console.log('1. POST /topups for ₹250.00');
    const res = await fetch(`${url}/topups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'demo', 'idempotency-key': `topup-${randomUUID()}` },
      body: JSON.stringify({ accountId: user, amountPaise: '25000' }),
    });
    const body = (await res.json()) as { topupId: string; status: string };
    console.log(`   -> ${res.status} ${JSON.stringify(body)}`);
    console.log(`   balance now ${rupees(await balance(app, user))}   (nothing credited: the provider has not confirmed)\n`);
    const paymentId = (await owner.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM topups WHERE transaction_id = $1', [body.topupId])).rows[0]!.provider_payment_id;

    // 2. The provider confirms... five times.
    console.log(`2. Provider sends payment.succeeded for ${paymentId.slice(0, 12)}… FIVE times (same event id)`);
    const reports = await provider.settle(paymentId, 'succeeded', { times: 5 });
    reports.forEach((r, i) => console.log(`   delivery ${i + 1}: ${r.attempts[0]!.status} ${JSON.stringify(r.attempts[0]!.body)}`));
    console.log(`   balance now ${rupees(await balance(app, user))}   (credited once)\n`);

    // 3. Someone who does not know the secret tries to confirm a second payment.
    console.log('3. A FORGED payment.succeeded (signed with the wrong secret) for the same payment');
    const forged = JSON.stringify(provider.buildEvent(paymentId, 'succeeded'));
    const t = Math.floor(Date.now() / 1000);
    const attack = await fetch(provider.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signWebhook('guessed-secret', forged, t) },
      body: forged,
    });
    console.log(`   -> ${attack.status} ${JSON.stringify(await attack.json())}`);
    console.log(`   balance now ${rupees(await balance(app, user))}\n`);

    // 4. What the ledger recorded.
    const events = await owner.query<{ provider_event_id: string; event_type: string; result: string }>(
      'SELECT provider_event_id, event_type, result FROM webhook_events WHERE provider_payment_id = $1 ORDER BY received_at',
      [paymentId],
    );
    console.log(`4. webhook_events for this payment: ${events.rows.length} row(s)`);
    for (const e of events.rows) console.log(`   ${e.provider_event_id.slice(0, 12)}…  ${e.event_type}  ->  ${e.result}`);
    const tx = await owner.query<{ status: string; entries: number }>(
      `SELECT status, (SELECT count(*)::int FROM entries WHERE transaction_id = $1) AS entries FROM transactions WHERE id = $1`,
      [body.topupId],
    );
    console.log(`   top-up ${body.topupId.slice(0, 8)}…: status ${tx.rows[0]!.status}, ${tx.rows[0]!.entries} entries`);
    console.log(`\nFinal: user ${rupees(await balance(app, user))}, bank_settlement ${rupees(await balance(app, bank))}.`);
    console.log('Five deliveries and one forgery; the money moved exactly once.');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.end();
    await owner.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
