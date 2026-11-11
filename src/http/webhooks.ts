import express, { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { processWebhookEvent, type WebhookTestHooks } from '../webhooks/process.js';
import { SIGNATURE_HEADER, verifyWebhookSignature } from '../webhooks/signature.js';
import { errorBody } from './errors.js';

// Loose on purpose: the provider owns this format and may add fields. We
// need an event id, a type and a payment id; amount/currency are checked
// against the top-up only when we are about to post.
const WebhookEventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
  data: z.object({
    paymentId: z.string().min(1).max(255),
    amountPaise: z.string().regex(/^[0-9]+$/).optional(),
    currency: z.string().length(3).optional(),
  }),
});

export interface WebhooksRouterOptions {
  webhookSecret: string;
  testHooks?: WebhookTestHooks;
}

/**
 * POST /webhooks/provider: the provider tells us what happened to a payment.
 *
 * Mounted BEFORE express.json() and using express.raw() so the signature is
 * verified over the exact bytes the provider signed. Re-serialising parsed
 * JSON would change key order or whitespace and break the HMAC.
 */
export function webhooksRouter(pool: Pool, options: WebhooksRouterOptions): Router {
  const router = Router();

  router.post('/webhooks/provider', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // 1. Is this really from the provider, and recent? Anything else: 401, nothing stored.
    const verified = verifyWebhookSignature({
      secret: options.webhookSecret,
      rawBody,
      header: req.header(SIGNATURE_HEADER),
    });
    if (!verified.ok) {
      res.status(401).json(errorBody('invalid_signature', `webhook rejected: ${verified.reason}`));
      return;
    }

    // 2. Genuine but unusable (not JSON, no id): 400, nothing stored. The
    //    provider will retry it, which is acceptable: a bug on their side is
    //    visible in their delivery logs, and we have nothing to key it on.
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json(errorBody('invalid_json', 'webhook body is not valid JSON'));
      return;
    }
    const parsed = WebhookEventSchema.safeParse(json);
    if (!parsed.success) {
      res.status(400).json(errorBody('invalid_event', 'webhook body is missing required fields', z.treeifyError(parsed.error)));
      return;
    }

    // 3. Apply it exactly once. Unexpected errors propagate -> 500 -> the provider retries.
    const outcome = await processWebhookEvent(pool, parsed.data, rawBody.toString('utf8'), options.testHooks ?? {});
    if (outcome.duplicate) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    res.status(200).json({ received: true, result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  });

  return router;
}
