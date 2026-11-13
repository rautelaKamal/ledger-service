// Seed accounts for the load test:  node dist/scripts/seed-load.js   (compose: `run seed`)
//
// As ledger_owner, creates LOAD_ACCOUNTS user accounts named "load-<run> <n>"
// and funds each one the proper way: a posted top-up from bank_settlement
// (balanced entries, balances updated, transaction posted), so reconciliation
// stays clean. Prints {"accounts":[...]} on STDOUT (nothing else goes there),
// so it can be redirected straight into load/out/accounts.json.
import pg from 'pg';

const url = process.env.OWNER_DATABASE_URL;
const count = Number(process.env.LOAD_ACCOUNTS ?? 10);
const fundPaise = BigInt(process.env.LOAD_FUND_PAISE ?? '10000000'); // ₹1,00,000 each
if (!url) {
  console.error('OWNER_DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const run = new Date().toISOString().replace(/[:.]/g, '-');
const accounts: string[] = [];
try {
  const bank = await client.query<{ id: string }>(
    `SELECT id FROM accounts WHERE kind = 'system' AND name = 'bank_settlement' AND currency = 'INR'`,
  );
  const bankId = bank.rows[0]?.id;
  if (!bankId) throw new Error('no INR bank_settlement account: run migrations first');

  for (let i = 1; i <= count; i++) {
    await client.query('BEGIN');
    try {
      const acc = await client.query<{ id: string }>(
        `INSERT INTO accounts (name, kind, currency) VALUES ($1, 'user', 'INR') RETURNING id`,
        [`load-${run} ${i}`],
      );
      const accountId = acc.rows[0]!.id;
      const tx = await client.query<{ id: string }>(`INSERT INTO transactions (kind, note) VALUES ('topup', 'load-test seed') RETURNING id`);
      const txId = tx.rows[0]!.id;
      await client.query(
        `INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise)
         VALUES ($1, $2, 'INR', 'debit', $3), ($1, $4, 'INR', 'credit', $3)`,
        [txId, bankId, fundPaise, accountId],
      );
      await client.query('UPDATE accounts SET balance_paise = balance_paise - $2 WHERE id = $1', [bankId, fundPaise]);
      await client.query('UPDATE accounts SET balance_paise = balance_paise + $2 WHERE id = $1', [accountId, fundPaise]);
      await client.query(`UPDATE transactions SET status = 'posted' WHERE id = $1`, [txId]);
      await client.query('COMMIT');
      accounts.push(accountId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  console.error(`seeded ${accounts.length} accounts "load-${run} 1..${count}", ${fundPaise} paise each`);
  console.log(JSON.stringify({ accounts }));
} finally {
  await client.end();
}
