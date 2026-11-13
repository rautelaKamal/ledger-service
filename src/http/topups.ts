import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { logger } from '../logger.js';
import { resultLabel, type ApiMetrics } from '../metrics.js';
import { IdempotencyKeyBusyError, IdempotencyKeyReusedError, runIdempotent, type IdempotentOptions } from '../idempotency.js';
import { findSettlementAccount } from '../ledger/topup.js';
import { enqueueOutbox } from '../outbox/enqueue.js';
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
 * POST /topups: start a top-up. No money moves here, and no provider is called here.
 *
 * Creates a 'topup' transaction (pending, no entries), the topups row (without a
 * paymentId yet) and an outbox command 'provider.create_payment', all in one
 * transaction, then answers 202. The outbox worker calls the provider and records
 * the paymentId; the money is credited only when the provider confirms by webhook.
 */
export function topupsRouter(pool: Pool, metrics: ApiMetrics, options: IdempotentOptions = {}): Router {
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

          // The link to the provider, without a paymentId yet: the worker fills
          // it in (once) after it has talked to the provider.
          await client.query(
            `INSERT INTO topups (transaction_id, account_id, currency, amount_paise)
             VALUES ($1, $2, $3, $4)`,
            [topupId, account.id, account.currency, BigInt(body.amountPaise)],
          );

          // The side effect, queued in the same transaction instead of performed
          // here. No network call holds this connection or the idempotency key.
          await enqueueOutbox(client, 'provider.create_payment', {
            topupId,
            accountId: account.id,
            currency: account.currency,
            amountPaise: body.amountPaise,
          });

          return { status: 202, body: { topupId, status: 'pending' }, transactionId: topupId };
        },
        options,
      );

      if (result.replayed) {
        res.setHeader('Idempotent-Replayed', 'true');
        metrics.idempotencyReplays.inc({ route: '/topups' });
        logger.info({ status: result.status, replayed: true }, 'top-up replayed from idempotency key');
      } else {
        const outcome = resultLabel(result.status, result.body);
        metrics.topups.inc({ result: outcome });
        const topupId = (result.body as { topupId?: string }).topupId;
        logger.info({ result: outcome, ...(topupId ? { topup_id: topupId } : {}) }, 'top-up');
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof IdempotencyKeyReusedError) {
        metrics.idempotencyRejections.inc({ route: '/topups', reason: 'key_reused' });
        res.status(422).json(errorBody('idempotency_key_reused', err.message));
        return;
      }
      if (err instanceof IdempotencyKeyBusyError) {
        metrics.idempotencyRejections.inc({ route: '/topups', reason: 'key_busy' });
        res.setHeader('Retry-After', '1');
        res.status(409).json(errorBody('request_in_progress', err.message));
        return;
      }
      metrics.topups.inc({ result: 'error' });
      throw err;
    }
  });

  return router;
}
