import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { IdempotencyKeyBusyError, IdempotencyKeyReusedError, runIdempotent, type IdempotentOptions } from '../idempotency.js';
import { findSettlementAccount } from '../ledger/topup.js';
import { ProviderError, type ProviderClient } from '../provider/client.js';
import { errorBody } from './errors.js';
import { readIdempotencyHeaders } from './idempotency-headers.js';

const TopupBody = z
  .object({
    accountId: z.uuid(),
    amountPaise: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive integer as a string (paise)'),
  })
  .strict();

type TopupBody = z.infer<typeof TopupBody>;

export function topupRequestHash(body: TopupBody): string {
  const canonical = JSON.stringify({ accountId: body.accountId, amountPaise: body.amountPaise });
  return createHash('sha256').update(`POST\n/topups\n${canonical}`).digest('hex');
}

/**
 * POST /topups: start a top-up. No money moves here.
 *
 * Creates a 'topup' transaction (pending, no entries), asks the provider for a
 * payment, records the link, answers 202. The money is credited only when the
 * provider confirms by webhook (see POST /webhooks/provider).
 */
export function topupsRouter(pool: Pool, provider: ProviderClient, options: IdempotentOptions = {}): Router {
  const router = Router();

  router.post('/topups', async (req, res) => {
    const headers = readIdempotencyHeaders(req, res);
    if (!headers) return;

    const parsed = TopupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorBody('invalid_body', 'request body is invalid', z.treeifyError(parsed.error)));
      return;
    }
    const body = parsed.data;

    try {
      const result = await runIdempotent(
        pool,
        { ...headers, requestHash: topupRequestHash(body) },
        async (client) => {
          // Who is being topped up, and can we settle in their currency?
          const { rows } = await client.query<{ id: string; kind: string; currency: string }>(
            'SELECT id, kind, currency FROM accounts WHERE id = $1',
            [body.accountId],
          );
          const account = rows[0];
          if (!account) {
            return { status: 404, body: errorBody('account_not_found', `account ${body.accountId} does not exist`) };
          }
          if (account.kind !== 'user') {
            return { status: 422, body: errorBody('not_a_user_account', 'only user accounts can be topped up') };
          }
          if (!(await findSettlementAccount(client, account.currency))) {
            return {
              status: 422,
              body: errorBody('unsupported_currency', `no settlement account for ${account.currency}; top-ups are not possible`),
            };
          }

          // The transaction exists from the start, pending and empty, so the
          // webhook has something to match against.
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO transactions (kind, note) VALUES ('topup', $1) RETURNING id`,
            [`top-up of ${body.amountPaise} ${account.currency}`],
          );
          const topupId = inserted.rows[0]!.id;

          // Ask the provider. This network call runs INSIDE the database
          // transaction (connection held, idempotency key locked) with a 3 s
          // timeout. Trade-off and the step-5 fix: see STEP-04-EXPLAINED.
          // Failure throws ProviderError -> everything rolls back -> 502,
          // nothing stored, the client retries with the same key.
          const { paymentId } = await provider.createPayment({
            amountPaise: BigInt(body.amountPaise),
            currency: account.currency,
            reference: topupId,
          });

          await client.query(
            `INSERT INTO topups (transaction_id, account_id, currency, amount_paise, provider_payment_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [topupId, account.id, account.currency, BigInt(body.amountPaise), paymentId],
          );

          return { status: 202, body: { topupId, status: 'pending' }, transactionId: topupId };
        },
        options,
      );

      if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof ProviderError) {
        res.status(502).json(errorBody('provider_unavailable', `${err.message}; nothing was stored, retry with the same key`));
        return;
      }
      if (err instanceof IdempotencyKeyReusedError) {
        res.status(422).json(errorBody('idempotency_key_reused', err.message));
        return;
      }
      if (err instanceof IdempotencyKeyBusyError) {
        res.setHeader('Retry-After', '1');
        res.status(409).json(errorBody('request_in_progress', err.message));
        return;
      }
      throw err;
    }
  });

  return router;
}
