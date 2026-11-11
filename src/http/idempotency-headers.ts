import type { Request, Response } from 'express';
import { errorBody } from './errors.js';

const MAX_HEADER_LENGTH = 255;

/**
 * Read X-Client-Id and Idempotency-Key, or answer the request with the right
 * error and return null. Shared by every endpoint that creates money movement.
 *
 * X-Client-Id stands in for authentication until a later step adds the real
 * thing; it is what idempotency keys are scoped to.
 */
export function readIdempotencyHeaders(req: Request, res: Response): { clientId: string; key: string } | null {
  const clientId = req.header('x-client-id');
  if (!clientId || clientId.length > MAX_HEADER_LENGTH) {
    res.status(401).json(errorBody('missing_client_id', 'X-Client-Id header is required (1-255 chars)'));
    return null;
  }
  const key = req.header('idempotency-key');
  if (!key || key.length > MAX_HEADER_LENGTH) {
    res.status(400).json(errorBody('missing_idempotency_key', 'Idempotency-Key header is required (1-255 chars)'));
    return null;
  }
  return { clientId, key };
}
