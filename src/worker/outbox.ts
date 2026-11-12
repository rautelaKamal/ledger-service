import { runWithRequestId } from '../context.js';
import type { Pool } from '../db.js';
import { logger } from '../logger.js';
import type { Handlers, OutboxRow } from './handlers.js';

export interface WorkerOptions {
  /** After this many failed attempts a row becomes 'dead' (dead-letter). */
  maxAttempts?: number;
  /** Backoff: min(base * 2^attempts, cap) * jitter, jitter uniform in [0.5, 1.5). */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** A handler that runs longer than this counts as failed (safety net over the clients' own 3 s timeouts). */
  handlerTimeoutMs?: number;
  /** Injected randomness so tests can make backoff deterministic. */
  random?: () => number;
  /** Called after each processed row (metrics hook): outcome, row, handler time in seconds. */
  onOutcome?: (outcome: RowOutcome, row: OutboxRow, handlerSeconds: number) => void;
  /** Test-only fault injection, reachable only through this option. */
  testHooks?: {
    /** Runs after the handler and the bookkeeping UPDATE, right before COMMIT. Throwing simulates a crash. */
    beforeCommit?: (row: OutboxRow) => Promise<void>;
  };
  log?: (line: string) => void;
}

export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_CAP_MS = 5 * 60_000;
export const DEFAULT_HANDLER_TIMEOUT_MS = 10_000;

export type RowOutcome = { status: 'idle' } | { status: 'sent' | 'retry' | 'dead'; id: bigint; type: string; error?: string };

/** How long to wait before attempt number `attempts + 1`. Exported so tests can check the curve. */
export function backoffMs(attempts: number, options: WorkerOptions): number {
  const base = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const cap = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const jitter = 0.5 + (options.random ?? Math.random)(); // [0.5, 1.5)
  return Math.round(Math.min(base * 2 ** attempts, cap) * jitter);
}

/**
 * Process AT MOST ONE outbox row, in its own transaction:
 *
 *   BEGIN
 *   SELECT … FOR UPDATE SKIP LOCKED LIMIT 1     claim one due row; rows other
 *                                               workers hold are skipped, not waited for
 *   SAVEPOINT; run the handler (side effect)
 *   success -> status 'sent'                    failure -> ROLLBACK TO SAVEPOINT,
 *                                               attempts+1, last_error, available_at
 *                                               pushed out (backoff), or 'dead'
 *   COMMIT                                      releases the row
 *
 * One row per transaction means a crash repeats at most ONE side effect, and
 * no transaction stays open across many network calls. (The production-scale
 * alternative, leasing, is described in STEP-05-EXPLAINED.)
 */
export async function processOneRow(pool: Pool, handlers: Handlers, options: WorkerOptions = {}): Promise<RowOutcome> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, type, payload, attempts, created_at
         FROM outbox
        WHERE status = 'pending' AND available_at <= now()
        ORDER BY available_at, id
        LIMIT 1
          FOR UPDATE SKIP LOCKED`,
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { status: 'idle' };
    }

    // The request that queued this row stored its id in the payload; run the
    // handler under the same id, so its logs and outgoing calls (X-Request-Id to
    // the provider / sink) share it. Rows queued outside a request get "outbox-<id>".
    const requestId = (row.payload as { requestId?: unknown } | null)?.requestId;
    const contextId = typeof requestId === 'string' ? requestId : `outbox-${row.id}`;

    await client.query('SAVEPOINT handler');
    let outcome: RowOutcome;
    const handlerStarted = process.hrtime.bigint();
    let handlerSeconds = 0;
    try {
      const handler = handlers[row.type];
      if (!handler) throw new Error(`no handler for outbox type ${row.type}`);
      try {
        await runWithRequestId(contextId, () => withTimeout(handler(row, client), handlerTimeoutMs, `handler for ${row.type}`));
      } finally {
        handlerSeconds = Number(process.hrtime.bigint() - handlerStarted) / 1e9;
      }
      await client.query('RELEASE SAVEPOINT handler');
      await client.query(`UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = $1`, [row.id]);
      outcome = { status: 'sent', id: row.id, type: row.type };
    } catch (err) {
      // The handler's own writes vanish; our bookkeeping about the failure stays.
      await client.query('ROLLBACK TO SAVEPOINT handler');
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        await client.query(`UPDATE outbox SET status = 'dead', attempts = $2, last_error = $3 WHERE id = $1`, [row.id, attempts, message]);
        outcome = { status: 'dead', id: row.id, type: row.type, error: message };
      } else {
        const delay = backoffMs(row.attempts, options);
        // clock_timestamp(), not now(): now() is frozen at the transaction's START,
        // and the handler may have spent seconds timing out since then. Measured
        // from the start, a short backoff would already be in the past.
        await client.query(
          `UPDATE outbox SET attempts = $2, last_error = $3, available_at = clock_timestamp() + ($4::text || ' milliseconds')::interval WHERE id = $1`,
          [row.id, attempts, message, String(delay)],
        );
        outcome = { status: 'retry', id: row.id, type: row.type, error: message };
      }
    }

    if (options.testHooks?.beforeCommit) await options.testHooks.beforeCommit(row);
    await client.query('COMMIT');
    options.log?.(`outbox ${row.id} ${row.type}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`);
    options.onOutcome?.(outcome, row, handlerSeconds);
    const line = {
      request_id: contextId,
      outbox_id: row.id.toString(),
      type: row.type,
      outcome: outcome.status,
      attempts: outcome.status === 'sent' ? row.attempts : row.attempts + 1,
      duration_ms: Math.round(handlerSeconds * 1000),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    if (outcome.status === 'sent') logger.info(line, 'outbox row handled');
    else logger.warn(line, 'outbox row failed');
    return outcome;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      connectionBroken = true;
    }
    throw err;
  } finally {
    client.release(connectionBroken ? true : undefined);
  }
}

/** Process due rows one by one until none is due or `limit` is reached. Returns the outcomes. */
export async function processAvailable(pool: Pool, handlers: Handlers, options: WorkerOptions = {}, limit = 100): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = [];
  for (let i = 0; i < limit; i++) {
    const outcome = await processOneRow(pool, handlers, options);
    if (outcome.status === 'idle') break;
    outcomes.push(outcome);
  }
  return outcomes;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
