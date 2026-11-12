import type { Pool } from '../db.js';
import type { Handlers } from './handlers.js';
import { processAvailable, processOneRow, type RowOutcome, type WorkerOptions } from './outbox.js';

export interface WorkerLoopOptions extends WorkerOptions {
  /** How long to sleep when no row is due. */
  pollIntervalMs?: number;
}

/**
 * The worker: a loop around processOneRow(), plus a clean way to stop it.
 * Tests drive it with tick(); `npm run worker` drives it with start()/stop().
 */
export class Worker {
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly handlers: Handlers,
    private readonly options: WorkerLoopOptions = {},
  ) {}

  /** Process everything that is due right now (up to `limit` rows). */
  tick(limit = 100): Promise<RowOutcome[]> {
    return processAvailable(this.pool, this.handlers, this.options, limit);
  }

  /** Run until stop() is called. Resolves once the current row (if any) is finished. */
  async start(): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 1_000;
    while (!this.stopping) {
      const outcome = await processOneRow(this.pool, this.handlers, this.options);
      if (outcome.status === 'idle' && !this.stopping) {
        // Sleep, but wake immediately if stop() is called.
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, pollIntervalMs);
        });
        this.wake = null;
      }
    }
  }

  /**
   * Take no new rows. The row being processed right now is finished and
   * committed first; start() then returns. This is what SIGTERM calls.
   */
  stop(): void {
    this.stopping = true;
    this.wake?.();
  }
}
