import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { logger } from '../logger.js';
import { resultLabel, type ApiMetrics } from '../metrics.js';
import {
  IdempotencyKeyBusyError,
  IdempotencyKeyReusedError,
  runIdempotent,
  type IdempotentOptions,
} from '../idempotency.js';
import { transferWithClient } from '../ledger/transfer.js';
import { errorBody, mapBusinessError } from './errors.js';
import { readIdempotencyHeaders } from './idempotency-headers.js';

// amountPaise is a STRING holding a positive integer, so the amount never
// passes through a JS number (which silently rounds above 2^53). "0", "007",
// "1.5", "-3", "1e3", "" and a JSON number are all rejected here, so every
// malformed amount is a 400 that is never stored under the key.
// .strict(): unknown fields are an error, not silently dropped. Otherwise two
// requests differing only in an ignored field would hash the same.
const TransferBody = z
  .object({
    fromAccountId: z.uuid(),
    toAccountId: z.uuid(),
    amountPaise: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive integer as a string (paise)'),
    note: z.string().max(500).optional(),
  })
  .strict();

type TransferBody = z.infer<typeof TransferBody>;

/**
 * The request fingerprint. Built from the VALIDATED body in a fixed key order,
 * so key order in the client's JSON does not matter, but any change in meaning does.
 */
export function transferRequestHash(body: TransferBody): string {
  const canonical = JSON.stringify({
    fromAccountId: body.fromAccountId,
    toAccountId: body.toAccountId,
    amountPaise: body.amountPaise,
    note: body.note, // omitted by JSON.stringify when undefined
  });
  return createHash('sha256').update(`POST\n/transfers\n${canonical}`).digest('hex');
}

export function transfersRouter(pool: Pool, metrics: ApiMetrics, options: IdempotentOptions = {}): Router {
  const router = Router();

  router.post('/transfers', async (req, res) => {
    const headers = readIdempotencyHeaders(req, res);
    if (!headers) return;

    // A malformed body is not stored under the key: there is no well-formed
    // request to fingerprint, and nothing happened.
    const parsed = TransferBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorBody('invalid_body', 'request body is invalid', z.treeifyError(parsed.error)));
      return;
    }
    const body = parsed.data;

    try {
      const result = await runIdempotent(
        pool,
        { ...headers, requestHash: transferRequestHash(body) },
        async (client) => {
          try {
            const { transactionId } = await transferWithClient(client, {
              fromAccountId: body.fromAccountId,
              toAccountId: body.toAccountId,
              amountPaise: BigInt(body.amountPaise),
              ...(body.note !== undefined ? { note: body.note } : {}),
            });
            return { status: 201, body: { transactionId }, transactionId };
          } catch (err) {
            // Business errors are answers: return them so they get stored and
            // replayed. Anything else is unexpected: rethrow, nothing is stored.
            const mapped = mapBusinessError(err);
            if (!mapped) throw err;
            return mapped;
          }
        },
        options,
      );

      if (result.replayed) {
        res.setHeader('Idempotent-Replayed', 'true');
        metrics.idempotencyReplays.inc({ route: '/transfers' });
        logger.info({ status: result.status, replayed: true }, 'transfer replayed from idempotency key');
      } else {
        const outcome = resultLabel(result.status, result.body);
        metrics.transfers.inc({ result: outcome });
        const transactionId = (result.body as { transactionId?: string }).transactionId;
        logger.info({ result: outcome, ...(transactionId ? { transaction_id: transactionId } : {}) }, 'transfer');
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof IdempotencyKeyReusedError) {
        metrics.idempotencyRejections.inc({ route: '/transfers', reason: 'key_reused' });
        res.status(422).json(errorBody('idempotency_key_reused', err.message));
        return;
      }
      if (err instanceof IdempotencyKeyBusyError) {
        metrics.idempotencyRejections.inc({ route: '/transfers', reason: 'key_busy' });
        res.setHeader('Retry-After', '1');
        res.status(409).json(errorBody('request_in_progress', err.message));
        return;
      }
      metrics.transfers.inc({ result: 'error' });
      throw err; // -> the app's error handler -> 500
    }
  });

  return router;
}
