// Step 7a: what the AI assistant's database role, ledger_agent, can and cannot do.
//
// The role has SELECT on four views (and the same columns of their base
// tables), nothing else. Row-level security filters every row to the client in
// app.client_id, which the agent sets per request, inside a transaction, with
// a bind parameter: SELECT set_config('app.client_id', $1, true).
//
// Every test here runs AS ledger_agent, through a real connection.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, type Pool, type PoolClient } from '../src/db.js';
import { transfer } from '../src/ledger/transfer.js';
import { PG, createAccount, fundAccount } from './helpers.js';
import { resetLedger } from './reset.js';

let app: Pool; // ledger_app
let owner: Pool; // ledger_owner
let agent: Pool; // ledger_agent

// Two clients, each with an account; one transfer between them; one top-up for A.
const A = `client-a-${randomUUID().slice(0, 8)}`;
const B = `client-b-${randomUUID().slice(0, 8)}`;
let accA: string;
let accB: string;
let accB2: string; // B's second account, never involved with A
let transferId: string;
let topupId: string;
let privateTransferId: string; // B -> B2, nothing to do with A

beforeAll(async () => {
  app = createPool(process.env.DATABASE_URL!, { max: 4 });
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  agent = createPool(process.env.AGENT_DATABASE_URL!, { max: 3 });
  await resetLedger(owner);

  accA = await createAccount(app, 'user', 'INR', 'A main', A);
  accB = await createAccount(app, 'user', 'INR', 'B main', B);
  accB2 = await createAccount(app, 'user', 'INR', 'B savings', B);
  await fundAccount(owner, accA, 10_000n);
  await fundAccount(owner, accB, 10_000n);
  transferId = (await transfer(app, { fromAccountId: accA, toAccountId: accB, amountPaise: 2_500n, note: 'rent' })).transactionId;
  privateTransferId = (await transfer(app, { fromAccountId: accB, toAccountId: accB2, amountPaise: 100n })).transactionId;

  // A pending top-up for A, as the API records it (transaction + topups row, no entries yet).
  const tx = await owner.query<{ id: string }>(`INSERT INTO transactions (kind, note) VALUES ('topup', 'top-up of 500 INR') RETURNING id`);
  topupId = tx.rows[0]!.id;
  await owner.query(`INSERT INTO topups (transaction_id, account_id, currency, amount_paise, provider_payment_id) VALUES ($1, $2, 'INR', 500, 'pay_secret_ref')`, [
    topupId,
    accA,
  ]);
});

afterAll(async () => {
  await Promise.all([app.end(), owner.end(), agent.end()]);
});

// ───────────── helpers ─────────────

/**
 * Exactly what the Python agent does per request: one read-only transaction,
 * the client id bound as a parameter (never pasted into SQL), then the queries.
 */
async function asClient<T>(clientId: string | null, fn: (db: PoolClient) => Promise<T>, mode: 'READ ONLY' | 'READ WRITE' = 'READ ONLY'): Promise<T> {
  const db = await agent.connect();
  try {
    await db.query(`BEGIN ${mode}`);
    if (clientId !== null) await db.query('SELECT set_config($1, $2, true)', ['app.client_id', clientId]);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id).sort();

// ───────────── tests ─────────────

describe('ledger_agent cannot write', () => {
  test('1. every INSERT, UPDATE and DELETE is refused by the grants, and the hidden tables are not readable at all', async () => {
    // READ WRITE on purpose: the refusals below must come from the GRANTs
    // (42501), not from the READ ONLY flag the agent also sets.
    await asClient(A, async (db) => {
      const denied = async (sql: string): Promise<void> => {
        await db.query('SAVEPOINT s');
        await expect(db.query(sql)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
        await db.query('ROLLBACK TO SAVEPOINT s');
      };
      await denied(`INSERT INTO accounts (name, kind, currency, owner_client_id) VALUES ('x', 'user', 'INR', '${A}')`);
      await denied(`INSERT INTO transactions (kind) VALUES ('transfer')`);
      await denied(`INSERT INTO entries (transaction_id, account_id, currency, direction, amount_paise) VALUES ('${transferId}', '${accA}', 'INR', 'credit', 1)`);
      await denied(`INSERT INTO topups (transaction_id, account_id, currency, amount_paise) VALUES ('${topupId}', '${accA}', 'INR', 1)`);
      await denied(`UPDATE accounts SET balance_paise = balance_paise + 1000000 WHERE id = '${accA}'`);
      await denied(`UPDATE transactions SET status = 'failed' WHERE id = '${transferId}'`);
      await denied(`DELETE FROM entries WHERE transaction_id = '${transferId}'`);
      await denied(`DELETE FROM accounts WHERE id = '${accB}'`);
      // Views are read-only too.
      await denied(`UPDATE agent_accounts SET balance_paise = 0 WHERE id = '${accA}'`);
      // Stored responses, raw webhook bodies, the outbox, reconciliation: not even SELECT.
      await denied('SELECT 1 FROM idempotency_keys');
      await denied('SELECT 1 FROM webhook_events');
      await denied('SELECT 1 FROM outbox');
      await denied('SELECT 1 FROM reconciliation_runs');
    }, 'READ WRITE');
  });
});

describe('row-level security: a client sees only their own rows', () => {
  test('2. the views show A exactly A\'s accounts, transactions, every leg of those transactions, and A\'s top-up', async () => {
    await asClient(A, async (db) => {
      const accounts = await db.query<{ id: string; name: string; balance_paise: bigint }>('SELECT id, name, balance_paise FROM agent_accounts ORDER BY name');
      expect(accounts.rows).toEqual([{ id: accA, name: 'A main', balance_paise: 7_500n }]);

      const txs = await db.query<{ id: string }>('SELECT id FROM agent_transactions');
      // the funding top-up (fundAccount), the transfer to B, the pending top-up; NOT B's private transfer
      expect(txs.rows).toHaveLength(3);
      expect(ids(txs.rows)).toContain(transferId);
      expect(ids(txs.rows)).toContain(topupId);
      expect(ids(txs.rows)).not.toContain(privateTransferId);

      const legs = await db.query<{ account_id: string; direction: string; amount_paise: bigint; own_account: boolean }>(
        'SELECT account_id, direction, amount_paise, own_account FROM agent_entries WHERE transaction_id = $1 ORDER BY direction',
        [transferId],
      );
      expect(legs.rows).toEqual([
        { account_id: accB, direction: 'credit', amount_paise: 2_500n, own_account: false }, // the counterparty leg: id and amount, as on a statement
        { account_id: accA, direction: 'debit', amount_paise: 2_500n, own_account: true },
      ]);

      const topups = await db.query<Record<string, unknown>>('SELECT * FROM agent_topups');
      expect(topups.rows).toHaveLength(1);
      expect(topups.rows[0]).toMatchObject({ transaction_id: topupId, account_id: accA, amount_paise: 500n, status: 'pending' });
      expect(Object.keys(topups.rows[0]!)).not.toContain('provider_payment_id');
    });
  });

  test('3. a hand-written query on the base tables gets the same fence: own rows, granted columns, no owner column', async () => {
    await asClient(A, async (db) => {
      const denied = async (sql: string): Promise<void> => {
        await db.query('SAVEPOINT s');
        await expect(db.query(sql)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
        await db.query('ROLLBACK TO SAVEPOINT s');
      };
      await denied('SELECT * FROM accounts'); // includes owner_client_id
      await denied('SELECT owner_client_id FROM accounts');
      await denied('SELECT provider_payment_id FROM topups');
      await denied('SELECT * FROM topups');

      expect(ids(await db.query<{ id: string }>('SELECT id FROM accounts').then((r) => r.rows))).toEqual([accA]);
      // Trying to reach B's name through a join: B's account row simply is not there.
      const reach = await db.query<{ name: string | null }>(
        `SELECT a.name FROM entries e LEFT JOIN accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 AND e.account_id = $2`,
        [transferId, accB],
      );
      expect(reach.rows).toEqual([{ name: null }]);
      expect((await db.query<{ id: string }>('SELECT id FROM transactions WHERE id = $1', [privateTransferId])).rows).toEqual([]);
      expect((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM entries')).rows[0]?.n).toBe('4'); // 2 legs of the funding top-up + 2 of the transfer
      expect((await db.query<{ id: string }>('SELECT agent_transaction_ids() AS id')).rows.map((r) => r.id).sort()).toEqual(
        ids(await db.query<{ id: string }>('SELECT id FROM agent_transactions').then((r) => r.rows)),
      );
    });
  });

  test('4. B sees B\'s world, with the shared transfer flipped around', async () => {
    await asClient(B, async (db) => {
      expect(ids((await db.query<{ id: string }>('SELECT id FROM agent_accounts')).rows)).toEqual([accB, accB2].sort());
      const txs = ids((await db.query<{ id: string }>('SELECT id FROM agent_transactions')).rows);
      expect(txs).toContain(transferId);
      expect(txs).toContain(privateTransferId);
      expect(txs).not.toContain(topupId);
      const mine = await db.query<{ account_id: string; own_account: boolean }>('SELECT account_id, own_account FROM agent_entries WHERE transaction_id = $1', [transferId]);
      expect(mine.rows.find((r) => r.account_id === accB)?.own_account).toBe(true);
      expect(mine.rows.find((r) => r.account_id === accA)?.own_account).toBe(false);
      expect((await db.query('SELECT 1 FROM agent_topups')).rows).toEqual([]);
    });
  });

  test('5. no client id, or an empty one, means no rows at all; and SET LOCAL ends with its transaction', async () => {
    const counts = async (db: PoolClient): Promise<number[]> =>
      Promise.all(
        ['agent_accounts', 'agent_transactions', 'agent_entries', 'agent_topups', 'accounts', 'transactions', 'entries', 'topups'].map(async (t) =>
          Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)).rows[0]?.n),
        ),
      );
    expect(await asClient(null, counts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await asClient('', counts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    // The same pooled connection, two transactions: the first sets A, the second sets nothing.
    const db = await agent.connect();
    try {
      await db.query('BEGIN READ ONLY');
      await db.query('SELECT set_config($1, $2, true)', ['app.client_id', A]);
      expect((await db.query('SELECT 1 FROM agent_accounts')).rows).toHaveLength(1);
      await db.query('COMMIT');
      expect((await db.query<{ v: string | null }>(`SELECT current_setting('app.client_id', true) AS v`)).rows[0]?.v ?? '').toBe('');
      expect((await db.query('SELECT 1 FROM agent_accounts')).rows).toHaveLength(0);
    } finally {
      db.release();
    }
  });

  test('6. a hostile client id is plain data: it matches no owner, and it matches exactly the owner it spells', async () => {
    const hostile = [
      `'; RESET ROLE; SET ROLE ledger_owner; --`,
      `${A}' OR '1'='1`,
      `"; DROP TABLE accounts; --`,
      `${A}\n; SELECT 1`,
      `${A}\u0000x`.replace('\u0000', ''), // (a NUL cannot be sent in a text parameter at all; everything else can)
    ];
    for (const h of hostile) {
      await asClient(h, async (db) => {
        // Postgres saw the whole string as one value ...
        expect((await db.query<{ v: string }>(`SELECT current_setting('app.client_id', true) AS v`)).rows[0]?.v).toBe(h);
        expect((await db.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u).toBe('ledger_agent');
        // ... that owns nothing (A's rows do not leak through a trailing "OR '1'='1'").
        expect((await db.query('SELECT 1 FROM agent_accounts')).rows).toEqual([]);
        expect((await db.query('SELECT 1 FROM agent_transactions')).rows).toEqual([]);
      });
    }
    // And a client whose id IS that string sees its own account, like any other client.
    const weird = `'; RESET ROLE; --`;
    const accWeird = await createAccount(app, 'user', 'INR', 'weird', weird);
    await asClient(weird, async (db) => {
      expect(ids((await db.query<{ id: string }>('SELECT id FROM agent_accounts')).rows)).toEqual([accWeird]);
    });
  });

  test('7. the service roles are not affected: ledger_app sees every account without any setting; the agent reads only migration filenames', async () => {
    expect((await app.query<{ n: string }>('SELECT count(*)::text AS n FROM accounts')).rows[0]?.n).not.toBe('0');
    expect(ids((await app.query<{ id: string }>('SELECT id FROM accounts WHERE id = ANY($1)', [[accA, accB, accB2]])).rows)).toEqual([accA, accB, accB2].sort());
    await asClient(null, async (db) => {
      expect((await db.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename')).rows.length).toBeGreaterThanOrEqual(8);
      await expect(db.query('SELECT applied_at FROM schema_migrations')).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    });
  });
});
