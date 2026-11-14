import type { Pool } from '../db.js';
import type { Handlers } from './handlers.js';
import { processAvailable, processOneRow, type RowOutcome, type WorkerOptions } from './outbox.js';

export interface WorkerLoopOptions extends WorkerOptions {
  /** How long a loop sleeps when no row is due. */
  pollIntervalMs?: number;
  /**
   * How many loops run at once in this process. Safe because each loop claims
   * its row with FOR UPDATE SKIP LOCKED: two loops never get the same row.
   * The pool needs at least this many connections (plus one for metrics).
   */
  concurrency?: number;
}

/**
 * The worker: N loops around processOneRow(), plus a clean way to stop them.
 * Tests drive it with tick(); `npm run worker` drives it with start()/stop().
 */
export class Worker {
  private stopping = false;
  private readonly wakers = new Set<() => void>();

  constructor(
    private readonly pool: Pool,
    private readonly handlers: Handlers,
    private readonly options: WorkerLoopOptions = {},
  ) {}

  /** Process everything that is due right now (up to `limit` rows), with one loop. */
  tick(limit = 100): Promise<RowOutcome[]> {
    return processAvailable(this.pool, this.handlers, this.options, limit);
  }

  /** Run `concurrency` loops until stop() is called. Resolves once every loop has finished its current row. */
  async start(): Promise<void> {
    const loops = Math.max(1, this.options.concurrency ?? 1);
    await Promise.all(Array.from({ length: loops }, () => this.loop()));
  }

  private async loop(): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 1_000;
    while (!this.stopping) {
      const outcome = await processOneRow(this.pool, this.handlers, this.options);
      if (outcome.status === 'idle' && !this.stopping) {
        // Sleep, but wake immediately if stop() is called.
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            this.wakers.delete(wake);
            resolve();
          };
          this.wakers.add(wake);
          setTimeout(wake, pollIntervalMs);
        });
      }
    }
  }

  /**
   * Take no new rows. Every loop finishes and commits the row it is working on;
   * start() then returns. This is what SIGTERM calls.
   */
  stop(): void {
    this.stopping = true;
    for (const wake of [...this.wakers]) wake();
  }
}
