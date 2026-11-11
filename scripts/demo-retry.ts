// Demo: the same transfer sent 5 times. Once with ONE Idempotency-Key (a client
// retrying after lost responses), once with 5 FRESH keys (5 genuinely new
// requests). Watch how much money moves each way.
//
//   npm run demo:retry        (needs the dev database up and migrated)
//
// Starts the real Express app in this process on a random port and talks to it
// over HTTP. Accounts are named "demo-retry <timestamp> …" so they never mix
// with real dev data. Entries are append-only, so the rows stay, labelled.
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createPool, type Pool } from '../src/db.js';

const RUN_TAG = `demo-retry ${new Date().toISOString()}`;
const AMOUNT_PAISE = 10_000n; // ₹100 per transfer

function rupees(paise: bigint): string {
  return `₹${(Number(paise) / 100).toFixed(2)}`;
}

async function createAccount(owner: Pool, label: string, kind: 'user' | 'system'): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO accounts (name, kind, currency) VALUES ($1, $2, 'INR') RETURNING id`,
    [`${RUN_TAG} ${label}`, kind],
  );
  return rows[0]!.id;
}

/** A proper posted topup from the demo's bank account (as ledger_owner). */
async function fund(owner: Pool, bankId: string, accountId: string, amountPaise: bigint): Promise<void> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const tx = await c.query<{ id: string }>(`INSERT INTO transactions (kind) VALUES ('topup') RETURNING id`);
    await c.query(
      `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
       VALUES ($1, $2, 'INR', 'debit', $3), ($1, $4, 'INR', 'credit', $3)`,
      [tx.rows[0]!.id, bankId, amountPaise, accountId],
    );
    await c.query('UPDATE accounts SET balance_paise = balance_paise - $2 WHERE id = $1', [bankId, amountPaise]);
    await c.query('UPDATE accounts SET balance_paise = balance_paise + $2 WHERE id = $1', [accountId, amountPaise]);
    await c.query(`UPDATE transactions SET status = 'posted' WHERE id = $1`, [tx.rows[0]!.id]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function balance(pool: Pool, id: string): Promise<bigint> {
  const { rows } = await pool.query<{ balance_paise: bigint }>('SELECT balance_paise FROM accounts WHERE id = $1', [id]);
  return rows[0]!.balance_paise;
}

async function post(url: string, key: string, body: unknown): Promise<void> {
  const res = await fetch(`${url}/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': 'demo-client', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { transactionId?: string; error?: { code: string } };
  const replayed = res.headers.get('idempotent-replayed') === 'true' ? '  Idempotent-Replayed: true' : '';
  const what = json.transactionId ? `transactionId ${json.transactionId.slice(0, 8)}…` : `error ${json.error?.code}`;
  console.log(`    key ${key.slice(0, 13)}…  ->  ${res.status}  ${what}${replayed}`);
}

async function scenario(
  title: string,
  url: string,
  owner: Pool,
  app: Pool,
  bank: string,
  keys: () => string,
): Promise<void> {
  const a = await createAccount(owner, `${title} A`, 'user');
  const b = await createAccount(owner, `${title} B`, 'user');
  await fund(owner, bank, a, 50_000n); // ₹500

  console.log(`\n${title}`);
  console.log(`    A starts with ${rupees(await balance(app, a))}, B with ${rupees(await balance(app, b))}. Sending ₹100 A -> B, 5 times.`);
  const body = { fromAccountId: a, toAccountId: b, amountPaise: AMOUNT_PAISE.toString(), note: 'rent' };
  for (let i = 0; i < 5; i++) await post(url, keys(), body);
  const moved = await balance(app, b);
  console.log(`    Result: A = ${rupees(await balance(app, a))}, B = ${rupees(moved)}  ->  money moved ${rupees(moved)} (${moved / AMOUNT_PAISE} transfer(s))`);
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
  const server = createApp(app).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  try {
    const bank = await createAccount(owner, 'bank', 'system');
    console.log(`Demo accounts are named "${RUN_TAG} …" in the dev database.`);

    const oneKey = `retry-${randomUUID()}`;
    await scenario('1. One key, sent 5 times (a client retrying after lost responses)', url, owner, app, bank, () => oneKey);
    await scenario('2. Five fresh keys (five genuinely new requests)', url, owner, app, bank, () => `new-${randomUUID()}`);

    console.log(`\nSame bytes on the wire both times. The key is the only difference.`);
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
