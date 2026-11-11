import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { IdempotencyKeyBusyError, IdempotencyKeyReusedError, runIdempotent } from '../idempotency.js';
import { transferWithClient } from '../ledger/transfer.js';
import { errorBody, mapBusinessError } from './errors.js';

// amountPaise is a STRING of digits, so the amount never passes through a JS
// number (which silently rounds above 2^53). "1.5", "-3", "1e3", "" and a JSON
// number are all rejected here. Zero is a valid string and is rejected by
// transfer() itself (InvalidAmountError -> 400).
// .strict(): unknown fields are an error, not silently dropped. Otherwise two
// requests differing only in an ignored field would hash the same.
const TransferBody = z
  .object({
    fromAccountId: z.uuid(),
    toAccountId: z.uuid(),
    amountPaise: z.string().regex(/^[0-9]+$/, 'must be a string of digits (paise)'),
    note: z.string().max(500).optional(),
  })
  .strict();

type TransferBody = z.infer<typeof TransferBody>;

const MAX_HEADER_LENGTH = 255;

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

export function transfersRouter(pool: Pool): Router {
  const router = Router();

  router.post('/transfers', async (req, res) => {
    // X-Client-Id stands in for authentication until a later step adds the
    // real thing; it is what idempotency keys are scoped to.
    const clientId = req.header('x-client-id');
    if (!clientId || clientId.length > MAX_HEADER_LENGTH) {
      res.status(401).json(errorBody('missing_client_id', 'X-Client-Id header is required (1-255 chars)'));
      return;
    }

    const key = req.header('idempotency-key');
    if (!key || key.length > MAX_HEADER_LENGTH) {
      res.status(400).json(errorBody('missing_idempotency_key', 'Idempotency-Key header is required (1-255 chars)'));
      return;
    }

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
        { clientId, key, requestHash: transferRequestHash(body) },
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
      );

      if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof IdempotencyKeyReusedError) {
        res.status(422).json(errorBody('idempotency_key_reused', err.message));
        return;
      }
      if (err instanceof IdempotencyKeyBusyError) {
        res.setHeader('Retry-After', '1');
        res.status(409).json(errorBody('request_in_progress', err.message));
        return;
      }
      throw err; // -> the app's error handler -> 500
    }
  });

  return router;
}
