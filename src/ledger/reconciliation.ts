import type { Pool, PoolClient } from '../db.js';

// Entries are the source of truth; accounts.balance_paise is a cached copy.
// This query lists every account whose cached balance disagrees with its entries.
// Convention: a credit increases a balance, a debit decreases it, so
//   balance = sum(credits) - sum(debits)   over entries of POSTED transactions.
// (Since migration 002, committed entries always belong to a posted transaction;
// the status filter keeps this query correct even if that rule were ever disabled.)
// An empty result means the ledger reconciles.
export const UNRECONCILED_ACCOUNTS_SQL = `
  SELECT a.id            AS account_id,
         a.name          AS account_name,
         a.balance_paise AS cached_paise,
         COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount_paise ELSE -e.amount_paise END)
                    FILTER (WHERE t.status = 'posted'), 0)::bigint AS computed_paise
    FROM accounts a
    LEFT JOIN entries e      ON e.account_id = a.id
    LEFT JOIN transactions t ON t.id = e.transaction_id
   GROUP BY a.id, a.name
  HAVING a.balance_paise <> COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount_paise ELSE -e.amount_paise END)
                                       FILTER (WHERE t.status = 'posted'), 0)
   ORDER BY a.id
`;

export interface UnreconciledAccount {
  account_id: string;
  account_name: string;
  cached_paise: bigint;
  computed_paise: bigint;
}

export async function findUnreconciledAccounts(db: Pool | PoolClient): Promise<UnreconciledAccount[]> {
  const { rows } = await db.query<UnreconciledAccount>(UNRECONCILED_ACCOUNTS_SQL);
  return rows;
}
