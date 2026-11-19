import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { logger } from '../logger.js';
import { errorBody } from './errors.js';

// Step 7d: owner-scoped READS for the web app.
//
//   GET /accounts                              the caller's accounts
//   GET /accounts/:id/transactions             the passbook: newest first, cursor pagination
//   GET /accounts/:id/balance-history?days=30  closing balance per day (IST), for the chart
//   GET /topups/:id                            one top-up and its timeline
//
// The same rule as the writes (step 7a): an account or top-up that is not the
// caller's answers EXACTLY like one that does not exist (404, same body), so a
// caller probing ids learns nothing. The real reason goes to the log.
//
// Dates: a transaction is placed in the passbook and the chart by created_at
// (when it happened). posted_at is stamped by the database at posting time; for
// a transfer the two are the same moment, for a top-up posting follows the bank.

const MAX_HEADER_LENGTH = 255;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

const Uuid = z.uuid();

function readClientId(req: Request, res: Response): string | null {
  const clientId = req.header('x-client-id');
  if (!clientId || clientId.length > MAX_HEADER_LENGTH) {
    res.status(401).json(errorBody('missing_client_id', 'X-Client-Id header is required (1-255 chars)'));
    return null;
  }
  return clientId;
}

function accountNotFound(res: Response, id: string): void {
  res.status(404).json(errorBody('account_not_found', `account ${id} does not exist`));
}

/** True when `id` is a user account owned by `clientId`. Logs why when it is not. */
async function ownsAccount(pool: Pool, clientId: string, id: string, route: string): Promise<boolean> {
  if (!Uuid.safeParse(id).success) return false;
  const { rows } = await pool.query<{ owner_client_id: string | null }>('SELECT owner_client_id FROM accounts WHERE id = $1', [id]);
  if (rows[0]?.owner_client_id === clientId) return true;
  logger.info({ client_id: clientId, account_id: id, route, reason: rows[0] ? 'not_owner' : 'missing' }, 'read refused: 404');
  return false;
}

// ── cursor: the (created_at, id) of the last row of the previous page ──
// created_at travels as Postgres's own text form, so no microseconds are lost
// to a JavaScript Date on the way.
const CursorParts = z.tuple([z.string().min(1).max(64), z.uuid()]);

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  const parts = CursorParts.safeParse(Buffer.from(cursor, 'base64url').toString('utf8').split('|'));
  return parts.success ? { createdAt: parts.data[0], id: parts.data[1] } : null;
}

interface PassbookRow {
  id: string;
  kind: 'transfer' | 'topup' | 'refund' | 'opening';
  status: 'pending' | 'posted' | 'failed';
  note: string | null;
  created_at: string;
  created_at_exact: string;
  posted_at: string | null;
  amount_paise: string; // signed: + money in, - money out
  balance_after_paise: string | null; // only for posted rows
  counterparty_name: string | null;
  counterparty_kind: 'user' | 'system' | null;
  counterparty_is_mine: boolean | null;
}

export function readsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/accounts', async (req, res) => {
    const clientId = readClientId(req, res);
    if (clientId === null) return;
    const { rows } = await pool.query<{ id: string; name: string; currency: string; balance_paise: string; created_at: string }>(
      `SELECT id, name, currency, balance_paise::text AS balance_paise, created_at
         FROM accounts WHERE owner_client_id = $1
        ORDER BY created_at, id`,
      [clientId],
    );
    // Pending top-ups are NOT in the balance (no entries until the bank confirms):
    // reported separately so the web can show them apart, never mixed in.
    const pending = await pool.query<{ account_id: string; n: number; paise: string }>(
      `SELECT tp.account_id, count(*)::int AS n, sum(tp.amount_paise)::text AS paise
         FROM topups tp JOIN transactions t ON t.id = tp.transaction_id
         JOIN accounts a ON a.id = tp.account_id
        WHERE a.owner_client_id = $1 AND t.status = 'pending'
        GROUP BY tp.account_id`,
      [clientId],
    );
    const byAccount = new Map(pending.rows.map((p) => [p.account_id, p]));
    res.json({
      accounts: rows.map((a) => ({
        id: a.id,
        name: a.name,
        currency: a.currency,
        balancePaise: a.balance_paise,
        createdAt: a.created_at,
        pendingTopups: byAccount.get(a.id)?.n ?? 0,
        pendingTopupsPaise: byAccount.get(a.id)?.paise ?? '0',
      })),
    });
  });

  router.get('/accounts/:id/transactions', async (req, res) => {
    const clientId = readClientId(req, res);
    if (clientId === null) return;
    const id = req.params.id;
    if (!(await ownsAccount(pool, clientId, id, 'transactions'))) return accountNotFound(res, id);

    const limit = z.coerce.number().int().min(1).max(MAX_PAGE).catch(DEFAULT_PAGE).parse(req.query.limit ?? DEFAULT_PAGE);
    const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
    if (rawCursor !== undefined && cursor === null) {
      res.status(400).json(errorBody('invalid_cursor', 'cursor is not one this API produced'));
      return;
    }

    // Posted rows carry the running balance: the account starts at 0 and its
    // balance is the sum of its entries (what reconciliation checks), so the
    // running sum in created_at order is the balance after each row. Pending
    // and failed top-ups have no entries: listed, but they move no balance.
    const { rows } = await pool.query<PassbookRow>(
      `WITH posted AS (
         SELECT t.id, t.kind, t.status, t.note, t.created_at, t.posted_at,
                CASE e.direction WHEN 'credit' THEN e.amount_paise ELSE -e.amount_paise END AS amount_paise,
                sum(CASE e.direction WHEN 'credit' THEN e.amount_paise ELSE -e.amount_paise END)
                  OVER (ORDER BY t.created_at, t.id) AS balance_after_paise
           FROM entries e JOIN transactions t ON t.id = e.transaction_id
          WHERE e.account_id = $1
       ), not_posted AS (
         SELECT t.id, t.kind, t.status, t.note, t.created_at, t.posted_at,
                tp.amount_paise, NULL::bigint AS balance_after_paise
           FROM topups tp JOIN transactions t ON t.id = tp.transaction_id
          WHERE tp.account_id = $1 AND t.status <> 'posted'
       ), rows AS (
         SELECT * FROM posted UNION ALL SELECT * FROM not_posted
       )
       SELECT r.id, r.kind, r.status, r.note, r.created_at, r.created_at::text AS created_at_exact, r.posted_at,
              r.amount_paise::text AS amount_paise, r.balance_after_paise::text AS balance_after_paise,
              cp.name AS counterparty_name, cp.kind AS counterparty_kind,
              CASE WHEN cp.kind IS NULL THEN NULL ELSE cp.owner_client_id IS NOT DISTINCT FROM $4 END AS counterparty_is_mine
         FROM rows r
         LEFT JOIN LATERAL (
           SELECT a.name, a.kind, a.owner_client_id
             FROM entries e2 JOIN accounts a ON a.id = e2.account_id
            WHERE e2.transaction_id = r.id AND e2.account_id <> $1
            LIMIT 1
         ) cp ON true
        WHERE $2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid)
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $5`,
      [id, cursor?.createdAt ?? null, cursor?.id ?? null, clientId, limit + 1],
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      transactions: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        note: r.note,
        createdAt: r.created_at,
        postedAt: r.posted_at,
        amountPaise: r.amount_paise,
        balanceAfterPaise: r.balance_after_paise,
        // A top-up's other side is the bank settlement account: say "top-up", not its name.
        counterparty: r.counterparty_kind === 'user' ? { name: r.counterparty_name, isMine: r.counterparty_is_mine } : null,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at_exact, last.id) : null,
    });
  });

  router.get('/accounts/:id/balance-history', async (req, res) => {
    const clientId = readClientId(req, res);
    if (clientId === null) return;
    const id = req.params.id;
    if (!(await ownsAccount(pool, clientId, id, 'balance-history'))) return accountNotFound(res, id);
    const days = z.coerce.number().int().min(1).max(366).catch(30).parse(req.query.days ?? 30);

    // One point per calendar day in India (Asia/Kolkata): the balance at the end
    // of that day, i.e. the running sum of every entry created before midnight.
    const { rows } = await pool.query<{ day: string; balance_paise: string }>(
      `WITH days AS (
         SELECT d::date AS day
           FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - ($2::int - 1),
                                (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') AS d
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
              COALESCE((
                SELECT sum(CASE e.direction WHEN 'credit' THEN e.amount_paise ELSE -e.amount_paise END)
                  FROM entries e JOIN transactions t ON t.id = e.transaction_id
                 WHERE e.account_id = $1
                   AND t.created_at < ((days.day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
              ), 0)::text AS balance_paise
         FROM days
        ORDER BY days.day`,
      [id, days],
    );
    res.json({ days: rows.map((r) => ({ day: r.day, balancePaise: r.balance_paise })) });
  });

  router.get('/topups/:id', async (req, res) => {
    const clientId = readClientId(req, res);
    if (clientId === null) return;
    const id = req.params.id;
    const notFound = (): void => void res.status(404).json(errorBody('topup_not_found', `top-up ${id} does not exist`));
    if (!Uuid.safeParse(id).success) return notFound();

    const { rows } = await pool.query<{
      account_id: string;
      owner_client_id: string | null;
      currency: string;
      amount_paise: string;
      provider_payment_id: string | null;
      status: 'pending' | 'posted' | 'failed';
      created_at: string;
      posted_at: string | null;
    }>(
      `SELECT tp.account_id, a.owner_client_id, tp.currency, tp.amount_paise::text AS amount_paise,
              tp.provider_payment_id, t.status, t.created_at, t.posted_at
         FROM topups tp
         JOIN transactions t ON t.id = tp.transaction_id
         JOIN accounts a ON a.id = tp.account_id
        WHERE tp.transaction_id = $1`,
      [id],
    );
    const topup = rows[0];
    if (topup?.owner_client_id !== clientId) {
      logger.info({ client_id: clientId, topup_id: id, reason: topup ? 'not_owner' : 'missing' }, 'read refused: 404');
      return notFound();
    }
    // Ownership is settled above; only then ask when the payment command went out (migration 012).
    const sent = await pool.query<{ at: string | null }>('SELECT topup_payment_sent_at($1) AS at', [id]);
    const events = await pool.query<{ provider_event_id: string; event_type: string; result: string; received_at: string }>(
      `SELECT provider_event_id, event_type, result, received_at
         FROM webhook_events WHERE topup_transaction_id = $1
        ORDER BY received_at, provider_event_id`,
      [id],
    );
    res.json({
      topupId: id,
      accountId: topup.account_id,
      currency: topup.currency,
      amountPaise: topup.amount_paise,
      status: topup.status,
      createdAt: topup.created_at,
      postedAt: topup.posted_at,
      // Set by the worker once the provider accepted the payment request.
      providerPaymentId: topup.provider_payment_id,
      // When the worker delivered the payment command to the provider (outbox sent_at).
      paymentSentAt: sent.rows[0]?.at ?? null,
      webhooks: events.rows.map((e) => ({ eventId: e.provider_event_id, type: e.event_type, result: e.result, receivedAt: e.received_at })),
    });
  });

  return router;
}
