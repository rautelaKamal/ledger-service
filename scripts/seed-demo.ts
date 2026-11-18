// The web demo's fictional people:  npm run seed:demo   (compose: `run --rm seed-demo`)
//
// As ledger_owner, once (it does nothing if the demo clients already exist):
//   - three people to "be" in the web app: demo-meera, demo-arjun, demo-kavya
//   - a few fictional shops they pay (owned by demo-merchants, not pickable)
//   - two accounts for the chaos test (demo-chaos), so it never touches the people
//   - 30 days of history: posted top-ups, one failed top-up each, transfers
//
// Every rupee goes through the same rules as real money: balanced entries,
// cached balances updated, transactions posted by the database's own triggers
// (posted_at is stamped NOW; only created_at is set to the day it "happened",
// which the passbook and the chart use). Nothing is left pending: a pending
// top-up older than 24 h is exactly what reconciliation reports as stale.
// The history is generated from a fixed seed, so every run makes the same one.
import pg from 'pg';

const url = process.env.OWNER_DATABASE_URL;
if (!url) {
  console.error('OWNER_DATABASE_URL is not set');
  process.exit(1);
}

type Who = 'meera' | 'arjun' | 'kavya';
const PEOPLE: Record<Who, { client: string; name: string; accounts: string[] }> = {
  meera: { client: 'demo-meera', name: 'Meera Iyer', accounts: ['Savings', 'Current'] },
  arjun: { client: 'demo-arjun', name: 'Arjun Rao', accounts: ['Shop', 'Personal'] },
  kavya: { client: 'demo-kavya', name: 'Kavya Nair', accounts: ['Savings'] },
};
const SHOPS = ['Annapurna Stores', 'City Metro Card', 'Coastal Power Co.', 'Chai Point Corner', 'Bookworm Books'];

// mulberry32: a tiny deterministic PRNG, so the demo history is the same every time.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(7_2026);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const rupees = (min: number, max: number): bigint => BigInt(Math.round(min + rand() * (max - min))) * 100n + BigInt(Math.floor(rand() * 4)) * 25n;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const exists = await client.query(`SELECT 1 FROM accounts WHERE owner_client_id = 'demo-meera' LIMIT 1`);
  if (exists.rowCount) {
    console.log('demo data already present: nothing to do');
    process.exit(0);
  }
  const bank = await client.query<{ id: string }>(`SELECT id FROM accounts WHERE kind = 'system' AND name = 'bank_settlement' AND currency = 'INR'`);
  const bankId = bank.rows[0]?.id;
  if (!bankId) throw new Error('no INR bank_settlement account: run migrations first');

  await client.query('BEGIN');
  const ids = new Map<string, string>(); // "meera:Savings" -> uuid
  const balance = new Map<string, bigint>();
  async function account(owner: string, name: string, key: string): Promise<void> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (name, kind, currency, owner_client_id, created_at)
       VALUES ($1, 'user', 'INR', $2, now() - interval '31 days') RETURNING id`,
      [name, owner],
    );
    ids.set(key, rows[0]!.id);
    balance.set(key, 0n);
  }
  for (const [who, p] of Object.entries(PEOPLE)) for (const a of p.accounts) await account(p.client, `${p.name}, ${a}`, `${who}:${a}`);
  for (const s of SHOPS) await account('demo-merchants', s, `shop:${s}`);
  await account('demo-chaos', 'Chaos test A', 'chaos:A');
  await account('demo-chaos', 'Chaos test B', 'chaos:B');

  // created_at in the past, at a plausible hour of the day in India.
  const at = (daysAgo: number, hourIst: number): string => {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    const ist = new Date(d.getTime() + 5.5 * 3_600_000);
    ist.setUTCHours(hourIst, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
    return new Date(ist.getTime() - 5.5 * 3_600_000).toISOString();
  };

  async function move(kind: 'transfer' | 'topup', from: string, to: string, paise: bigint, when: string, note: string | null): Promise<void> {
    const debitId = from === 'bank' ? bankId! : ids.get(from)!;
    const creditId = ids.get(to)!;
    const tx = await client.query<{ id: string }>(`INSERT INTO transactions (kind, note, created_at) VALUES ($1, $2, $3) RETURNING id`, [kind, note, when]);
    const txId = tx.rows[0]!.id;
    if (kind === 'topup') {
      await client.query(`INSERT INTO topups (transaction_id, account_id, currency, amount_paise, provider_payment_id, created_at) VALUES ($1, $2, 'INR', $3, $4, $5)`, [
        txId,
        creditId,
        paise,
        `seed_pay_${txId.slice(0, 8)}`,
        when,
      ]);
    }
    await client.query(
      `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise, created_at)
       VALUES ($1, $2, 'INR', 'debit', $3, $5), ($1, $4, 'INR', 'credit', $3, $5)`,
      [txId, debitId, paise, creditId, when],
    );
    await client.query('UPDATE accounts SET balance_paise = balance_paise - $2 WHERE id = $1', [debitId, paise]);
    await client.query('UPDATE accounts SET balance_paise = balance_paise + $2 WHERE id = $1', [creditId, paise]);
    await client.query(`UPDATE transactions SET status = 'posted' WHERE id = $1`, [txId]);
    if (from !== 'bank') balance.set(from, balance.get(from)! - paise);
    balance.set(to, balance.get(to)! + paise);
  }

  async function failedTopup(to: string, paise: bigint, when: string): Promise<void> {
    const tx = await client.query<{ id: string }>(`INSERT INTO transactions (kind, created_at) VALUES ('topup', $1) RETURNING id`, [when]);
    const txId = tx.rows[0]!.id;
    await client.query(`INSERT INTO topups (transaction_id, account_id, currency, amount_paise, provider_payment_id, created_at) VALUES ($1, $2, 'INR', $3, $4, $5)`, [
      txId,
      ids.get(to)!,
      paise,
      `seed_pay_${txId.slice(0, 8)}`,
      when,
    ]);
    await client.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [txId]);
  }

  // Opening money, 30 days ago.
  await move('topup', 'bank', 'meera:Savings', 85_000_00n, at(30, 10), 'salary');
  await move('topup', 'bank', 'meera:Current', 20_000_00n, at(30, 11), null);
  await move('topup', 'bank', 'arjun:Shop', 2_40_000_00n, at(30, 9), 'opening float');
  await move('topup', 'bank', 'arjun:Personal', 30_000_00n, at(30, 12), null);
  await move('topup', 'bank', 'kavya:Savings', 12_000_00n, at(30, 18), 'pocket money');
  await move('topup', 'bank', 'chaos:A', 10_000_00n, at(30, 3), 'chaos test float');
  await move('topup', 'bank', 'chaos:B', 10_000_00n, at(30, 3), 'chaos test float');

  // Daily life: spends at shops, a few transfers between people, top-ups.
  const notes = ['groceries', 'metro recharge', 'electricity bill', 'tea and snacks', 'textbooks', null, null];
  for (let day = 29; day >= 0; day--) {
    for (const who of ['meera', 'arjun', 'kavya'] as const) {
      if (rand() < 0.45) {
        const from = `${who}:${PEOPLE[who].accounts[0]!}`;
        const amount = who === 'kavya' ? rupees(40, 450) : rupees(120, 3_200);
        if (balance.get(from)! > amount + 1_000_00n) await move('transfer', from, `shop:${pick(SHOPS)}`, amount, at(day, 8 + Math.floor(rand() * 13)), pick(notes));
      }
    }
    if (day % 6 === 2) {
      const a = balance.get('arjun:Shop')!;
      if (a > 6_000_00n) await move('transfer', 'arjun:Shop', 'meera:Savings', rupees(1_500, 4_500), at(day, 16), 'shop rent share');
    }
    if (day % 7 === 4) await move('transfer', 'meera:Savings', 'kavya:Savings', rupees(800, 2_000), at(day, 20), 'for books');
    if (day % 9 === 5) await move('transfer', 'meera:Savings', 'meera:Current', rupees(2_000, 6_000), at(day, 9), 'monthly budget');
    if (day === 15) await move('topup', 'bank', 'arjun:Shop', 45_000_00n, at(day, 18), 'card settlements');
    if (day === 12) await move('topup', 'bank', 'kavya:Savings', 3_000_00n, at(day, 19), null);
  }
  await failedTopup('meera:Savings', 3_000_00n, at(6, 14));
  await failedTopup('arjun:Personal', 12_500_00n, at(4, 11));
  await failedTopup('kavya:Savings', 500_00n, at(2, 21));

  await client.query('COMMIT');
  for (const [who, p] of Object.entries(PEOPLE)) {
    const total = p.accounts.reduce((s, a) => s + balance.get(`${who}:${a}`)!, 0n);
    console.log(`${p.client.padEnd(12)} ${p.name.padEnd(11)} ${p.accounts.join(' + ')}: ${total} paise`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
