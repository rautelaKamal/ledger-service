import type { Pool, PoolClient } from './db.js';

/** Identifies one request: who sent it, under which key, and what exactly it asked for. */
export interface IdempotencyScope {
  clientId: string;
  key: string;
  /** sha256 hex of method + path + canonical body. */
  requestHash: string;
}

/** What the work produced: an HTTP status and JSON body to store and (later) replay. */
export interface WorkResult {
  status: number;
  body: unknown;
  /** The transaction this request created, if any (stored for audit). */
  transactionId?: string;
}

/**
 * The work runs on the SAME client as the key row, inside the same database
 * transaction. It must return a WorkResult for every business outcome
 * (success or business error) and THROW only for unexpected failures.
 */
export type IdempotentWork = (client: PoolClient) => Promise<WorkResult>;

export interface IdempotentOptions {
  /**
   * How long a duplicate request may wait for the FIRST request with the same
   * key to finish before giving up with IdempotencyKeyBusyError (HTTP 409).
   * Applies to the key claim only, never to the work's own locks.
   * Default 5 s; tests use 1 s to stay fast.
   */
  keyClaimTimeoutMs?: number;
}

export interface IdempotentResult {
  status: number;
  body: unknown;
  /** true when this response came from the stored row, not from running the work. */
  replayed: boolean;
}

/** Same key, different request (fingerprint mismatch). HTTP 422. */
export class IdempotencyKeyReusedError extends Error {
  override name = 'IdempotencyKeyReusedError';
}

/** Another request with this key is still running and we gave up waiting. HTTP 409. */
export class IdempotencyKeyBusyError extends Error {
  override name = 'IdempotencyKeyBusyError';
}

export const DEFAULT_KEY_CLAIM_TIMEOUT_MS = 5_000;
const LOCK_NOT_AVAILABLE = '55P03'; // SQLSTATE raised when lock_timeout fires

interface ExistingKeyRow {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  expired: boolean;
}

/**
 * Run `work` at most once per (client, key).
 *
 * The key row, the work's writes and the stored response live in ONE database
 * transaction, so they commit together or not at all:
 *   - unexpected error  -> ROLLBACK everything; the key was never stored; retry works
 *   - business error    -> keep the key + response, drop the work's writes (savepoint)
 *   - success           -> keep everything
 *
 * A duplicate request arriving while the first is still running blocks on the
 * key's primary key until the first finishes, then replays its result. If the
 * first takes longer than keyClaimTimeoutMs, the duplicate gives up with
 * IdempotencyKeyBusyError (HTTP 409 + Retry-After) instead of waiting forever.
 */
export async function runIdempotent(
  pool: Pool,
  scope: IdempotencyScope,
  work: IdempotentWork,
  options: IdempotentOptions = {},
): Promise<IdempotentResult> {
  const keyClaimTimeoutMs = options.keyClaimTimeoutMs ?? DEFAULT_KEY_CLAIM_TIMEOUT_MS;
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('BEGIN');

    // Step 1: claim the key, or find out who already has it.
    // The wait on the key row is bounded (set_config(..., true) = SET LOCAL:
    // it lasts for this transaction only). Prevents: a slow or stuck first
    // request making its duplicates pile up on connections indefinitely.
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${keyClaimTimeoutMs}ms`]);
    const existing = await claimKey(client, scope);
    // Back to "wait as long as it takes" for everything after the claim. The
    // work's own row locks (account rows under contention) are ordinary queuing,
    // not a sign that this key is busy, so they must never turn into a 409.
    await client.query(`SELECT set_config('lock_timeout', '0', true)`);
    if (existing) {
      // Someone finished this request before us. Nothing to do; hand back their answer.
      await client.query('ROLLBACK');
      return { status: existing.response_status!, body: existing.response_body, replayed: true };
    }

    // Step 2: run the work behind a savepoint. A business error is a real
    // answer that must be remembered, but whatever the work wrote before
    // failing must not survive.
    await client.query('SAVEPOINT before_work');
    const result = await work(client);
    if (result.status >= 400) {
      await client.query('ROLLBACK TO SAVEPOINT before_work');
    } else {
      await client.query('RELEASE SAVEPOINT before_work');
    }

    // Step 3: store the response on the key row we claimed in step 1.
    await client.query(
      `UPDATE idempotency_keys
          SET response_status = $3, response_body = $4::jsonb, transaction_id = $5
        WHERE client_id = $1 AND key = $2`,
      [scope.clientId, scope.key, result.status, JSON.stringify(result.body), result.transactionId ?? null],
    );

    // Step 4: COMMIT makes the key, the work's writes and the response visible together.
    await client.query('COMMIT');
    return { status: result.status, body: result.body, replayed: false };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      connectionBroken = true;
    }
    if (isPgError(err) && err.code === LOCK_NOT_AVAILABLE) {
      // Only the key claim runs with a lock_timeout, so this can only mean
      // "the first request with this key is still running".
      throw new IdempotencyKeyBusyError(
        `another request with key "${scope.key}" is still being processed (waited ${keyClaimTimeoutMs} ms)`,
      );
    }
    throw err;
  } finally {
    client.release(connectionBroken ? true : undefined);
  }
}

/**
 * Insert the key row. Returns null if we now own the key, or the existing
 * committed row if someone else already completed this key.
 *
 * `ON CONFLICT DO NOTHING` is what makes concurrent duplicates safe: if another
 * transaction has inserted the same key but not yet committed, this INSERT
 * WAITS for it. If that transaction commits, we get 0 rows and read its result.
 * If it rolls back, our insert succeeds and we proceed as if we were first.
 * (A plain INSERT would throw a unique violation after the wait and abort our
 * transaction; DO NOTHING just reports 0 rows.)
 */
async function claimKey(client: PoolClient, scope: IdempotencyScope): Promise<ExistingKeyRow | null> {
  // Two passes are enough: pass 1 may find an expired row and delete it,
  // pass 2 then inserts (or finds a live row written meanwhile by someone else).
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (client_id, key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, key) DO NOTHING
       RETURNING 1`,
      [scope.clientId, scope.key, scope.requestHash],
    );
    if (inserted.rowCount === 1) return null; // the key is ours

    const { rows } = await client.query<ExistingKeyRow>(
      `SELECT request_hash, response_status, response_body, expires_at <= now() AS expired
         FROM idempotency_keys
        WHERE client_id = $1 AND key = $2`,
      [scope.clientId, scope.key],
    );
    const existing = rows[0];
    if (!existing) continue; // deleted between our INSERT and SELECT (cleanup); try again

    if (existing.expired) {
      // A key older than 24 hours is forgotten: delete it and claim afresh.
      // (The trigger only allows deleting expired rows, so this cannot touch a live key.)
      await client.query(`DELETE FROM idempotency_keys WHERE client_id = $1 AND key = $2 AND expires_at <= now()`, [
        scope.clientId,
        scope.key,
      ]);
      continue;
    }

    if (existing.request_hash !== scope.requestHash) {
      throw new IdempotencyKeyReusedError(
        `key "${scope.key}" was already used for a different request; use a new key`,
      );
    }
    if (existing.response_status === null) {
      // Cannot happen: a committed row always carries its response (see migration 003).
      throw new Error(`idempotency key "${scope.key}" is committed without a response`);
    }
    return existing;
  }
  throw new Error(`could not claim idempotency key "${scope.key}" after 3 attempts`);
}

/**
 * Delete keys older than 24 hours. Returns how many were deleted.
 * Called by a scheduled job (added with the Kubernetes step).
 */
export async function deleteExpiredIdempotencyKeys(pool: Pool): Promise<number> {
  const result = await pool.query('DELETE FROM idempotency_keys WHERE expires_at <= now()');
  return result.rowCount ?? 0;
}

function isPgError(err: unknown): err is { code: string } {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}
