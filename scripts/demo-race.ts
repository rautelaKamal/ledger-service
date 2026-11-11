// Demo: watch the two classic money bugs happen, then watch transfer() avoid them.
//
//   npm run demo:race        (needs the dev database up and migrated)
//
// Runs against the DEV database (`ledger`). Every account it creates is named
// "demo-race <timestamp> <A|B>" so you can always tell demo rows from real ones.
// Entries are append-only, so the demo cannot delete what it wrote: the rows
// stay, clearly labelled. The naive versions of transfer live ONLY in this file.
import pg from 'pg';
import { createPool, type Pool } from '../src/db.js';
import { findUnreconciledAccounts } from '../src/ledger/reconciliation.js';
import { InsufficientFundsError, transfer } from '../src/ledger/transfer.js';

// ───────────────────────── helpers ─────────────────────────

const RUN_TAG = `demo-race ${new Date().toISOString()}`;
const DEADLOCK = '40P01';

type Transfer = (pool: Pool, from: string, to: string, amountPaise: bigint) => Promise<unknown>;

async function createDemoAccount(owner: Pool, label: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO accounts (name, kind, currency) VALUES ($1, 'user', 'INR') RETURNING id`,
    [`${RUN_TAG} ${label}`],
  );
  return rows[0]!.id;
}

/** Fund an account the proper way: a posted topup from the demo's own bank account. */
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

async function booksBalance(owner: Pool, ids: string[]): Promise<string> {
  const bad = (await findUnreconciledAccounts(owner)).filter((r) => ids.includes(r.account_id));
  if (bad.length === 0) return 'YES (cached balance = credits - debits for every demo account)';
  return (
    'NO:\n' +
    bad.map((r) => `      account ${r.account_id.slice(0, 8)}…: cached ${r.cached_paise}, entries say ${r.computed_paise}`).join('\n')
  );
}

function rupees(paise: bigint): string {
  return `₹${(Number(paise) / 100).toFixed(2)}`;
}

function summarise(results: PromiseSettledResult<unknown>[]): {
  ok: number;
  insufficient: number;
  deadlocks: number;
  poolTimeouts: number;
  other: string[];
} {
  let ok = 0;
  let insufficient = 0;
  let deadlocks = 0;
  let poolTimeouts = 0;
  const other: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') ok++;
    else if (r.reason instanceof InsufficientFundsError) insufficient++;
    else if ((r.reason as { code?: string }).code === DEADLOCK) deadlocks++;
    else if (String((r.reason as Error).message).includes('timeout exceeded when trying to connect')) poolTimeouts++;
    else other.push(String((r.reason as Error).message));
  }
  return { ok, insufficient, deadlocks, poolTimeouts, other };
}

function printErrors(s: ReturnType<typeof summarise>): void {
  if (s.poolTimeouts) {
    console.log(
      `    gave up waiting for a connection: ${s.poolTimeouts}  (the deadlocked transfers held their connections` +
        ` for ~1 s each, so the rest of the queue timed out after 10 s)`,
    );
  }
  if (s.other.length) console.log(`    other errors: ${[...new Set(s.other)].join(' | ')}`);
}

// ───────────────────────── the three implementations ─────────────────────────

/**
 * NAIVE #1: no locks. Read the balance, check it, write back a computed value.
 * Each statement is its own little transaction. This is what most people
 * write first, and it is wrong under concurrency.
 */
const naiveNoLock: Transfer = async (pool, from, to, amount) => {
  const { rows } = await pool.query<{ id: string; balance_paise: bigint }>(
    'SELECT id, balance_paise FROM accounts WHERE id = ANY($1::uuid[])',
    [[from, to]],
  );
  const sender = rows.find((r) => r.id === from)!;
  const receiver = rows.find((r) => r.id === to)!;
  if (sender.balance_paise < amount) throw new InsufficientFundsError('insufficient funds');

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const tx = await c.query<{ id: string }>(`INSERT INTO transactions (kind) VALUES ('transfer') RETURNING id`);
    await c.query(
      `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
       VALUES ($1, $2, 'INR', 'debit', $3), ($1, $4, 'INR', 'credit', $3)`,
      [tx.rows[0]!.id, from, amount, to],
    );
    // Writes the value it computed from a possibly stale read.
    await c.query('UPDATE accounts SET balance_paise = $2 WHERE id = $1', [from, sender.balance_paise - amount]);
    await c.query('UPDATE accounts SET balance_paise = $2 WHERE id = $1', [to, receiver.balance_paise + amount]);
    await c.query(`UPDATE transactions SET status = 'posted' WHERE id = $1`, [tx.rows[0]!.id]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
};

/**
 * NAIVE #2: locks, but in the "obvious" order: sender first, then receiver.
 * Correct for one direction of traffic. Deadlocks as soon as A->B and B->A overlap.
 */
const naiveLockSenderFirst: Transfer = async (pool, from, to, amount) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const s = await c.query<{ balance_paise: bigint }>('SELECT balance_paise FROM accounts WHERE id = $1 FOR UPDATE', [from]);
    await c.query('SELECT balance_paise FROM accounts WHERE id = $1 FOR UPDATE', [to]);
    if (s.rows[0]!.balance_paise < amount) throw new InsufficientFundsError('insufficient funds');

    const tx = await c.query<{ id: string }>(`INSERT INTO transactions (kind) VALUES ('transfer') RETURNING id`);
    await c.query(
      `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
       VALUES ($1, $2, 'INR', 'debit', $3), ($1, $4, 'INR', 'credit', $3)`,
      [tx.rows[0]!.id, from, amount, to],
    );
    await c.query('UPDATE accounts SET balance_paise = balance_paise - $2 WHERE id = $1', [from, amount]);
    await c.query('UPDATE accounts SET balance_paise = balance_paise + $2 WHERE id = $1', [to, amount]);
    await c.query(`UPDATE transactions SET status = 'posted' WHERE id = $1`, [tx.rows[0]!.id]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
};

/** The real one. */
const real: Transfer = (pool, from, to, amount) =>
  transfer(pool, { fromAccountId: from, toAccountId: to, amountPaise: amount });

// ───────────────────────── the two scenarios ─────────────────────────

/** Scenario 1: A has ₹50. Fire 100 concurrent ₹1 transfers A -> B. Correct answer: 50 succeed. */
async function overdraftScenario(app: Pool, owner: Pool, bank: string, impl: Transfer, label: string): Promise<void> {
  const a = await createDemoAccount(owner, `${label} A`);
  const b = await createDemoAccount(owner, `${label} B`);
  await fund(owner, bank, a, 5_000n);

  const started = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => impl(app, a, b, 100n)));
  const s = summarise(results);

  console.log(`    100 concurrent ₹1 transfers from A (₹50) to B, took ${Date.now() - started} ms`);
  console.log(`    succeeded: ${s.ok}   insufficient funds: ${s.insufficient}   deadlocks: ${s.deadlocks}`);
  printErrors(s);
  console.log(`    A = ${rupees(await balance(app, a))}   B = ${rupees(await balance(app, b))}   (expected A = ₹0.00, B = ₹50.00)`);
  console.log(`    books balance? ${await booksBalance(owner, [a, b])}`);
}

/** Scenario 2: 50 A -> B and 50 B -> A at once. Correct answer: all 100 succeed, 0 deadlocks. */
async function crossTrafficScenario(app: Pool, owner: Pool, bank: string, impl: Transfer, label: string): Promise<void> {
  const a = await createDemoAccount(owner, `${label} A`);
  const b = await createDemoAccount(owner, `${label} B`);
  await fund(owner, bank, a, 5_000n);
  await fund(owner, bank, b, 5_000n);

  const started = Date.now();
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < 50; i++) {
    jobs.push(impl(app, a, b, 100n));
    jobs.push(impl(app, b, a, 100n));
  }
  const s = summarise(await Promise.allSettled(jobs));

  const total = (await balance(app, a)) + (await balance(app, b));
  console.log(`    50 x A->B and 50 x B->A (₹1 each) at the same time, took ${Date.now() - started} ms`);
  console.log(`    succeeded: ${s.ok}   deadlocks (40P01): ${s.deadlocks}   insufficient funds: ${s.insufficient}`);
  printErrors(s);
  console.log(`    A = ${rupees(await balance(app, a))}   B = ${rupees(await balance(app, b))}   total ${rupees(total)} (expected total ₹100.00)`);
  console.log(`    books balance? ${await booksBalance(owner, [a, b])}`);
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.OWNER_DATABASE_URL;
  if (!appUrl || !ownerUrl) {
    console.error('DATABASE_URL and OWNER_DATABASE_URL must be set (copy .env.example to .env)');
    process.exit(1);
  }

  // Same pool size as the tests: ~20 transfers in flight at once.
  const app = createPool(appUrl, { max: 20 });
  const owner = createPool(ownerUrl, { max: 2 });

  try {
    const bank = await createDemoAccountAsSystem(owner);
    console.log(`Demo accounts are named "${RUN_TAG} …" in the dev database.\n`);

    console.log('1. NAIVE transfer (no locks: read balance, check, write back)');
    await overdraftScenario(app, owner, bank, naiveNoLock, 'naive-nolock');

    console.log('\n2. Lock SENDER first, then receiver (locks, wrong order)');
    await crossTrafficScenario(app, owner, bank, naiveLockSenderFirst, 'naive-senderfirst');

    console.log('\n3. The real transfer(): locks both rows in ascending id order');
    console.log('   3a. overdraft scenario');
    await overdraftScenario(app, owner, bank, real, 'real');
    console.log('   3b. cross-traffic scenario');
    await crossTrafficScenario(app, owner, bank, real, 'real');

    console.log(
      `\nDone. Entries are append-only, so the demo rows stay; look for accounts named "${RUN_TAG} …".`,
    );
  } finally {
    await app.end();
    await owner.end();
  }
}

async function createDemoAccountAsSystem(owner: Pool): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO accounts (name, kind, currency) VALUES ($1, 'system', 'INR') RETURNING id`,
    [`${RUN_TAG} bank`],
  );
  return rows[0]!.id;
}

main().catch((err: unknown) => {
  console.error(err instanceof pg.DatabaseError ? `${err.code} ${err.message}` : err);
  process.exit(1);
});
