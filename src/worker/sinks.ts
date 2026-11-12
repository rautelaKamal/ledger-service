// Where outbox EVENTS go ('transfer.posted', 'topup.posted', 'topup.failed').
// Today a stand-in; later a queue, a webhook to another service, an analytics
// pipeline. Whatever it is, it receives each event AT LEAST once and must
// dedupe by outboxId.

export interface OutboxEvent {
  /** The outbox row id: the consumer's dedupe key. */
  outboxId: string;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface NotificationSink {
  deliver(event: OutboxEvent): Promise<void>;
}

/** The sink was unreachable, too slow, or refused the event. The outbox row is retried. */
export class SinkError extends Error {
  override name = 'SinkError';
}

export const DEFAULT_SINK_TIMEOUT_MS = 3_000;

/** For tests and demos: remembers what it got and counts redeliveries it deduped. */
export class MemorySink implements NotificationSink {
  readonly received: OutboxEvent[] = [];
  readonly deliveries: string[] = []; // every call, duplicates included
  duplicates = 0;
  /** If set, the next deliver() throws this (then clears). */
  failNext: Error | null = null;
  /** If set, every deliver() throws this. */
  failAlways: Error | null = null;
  delayMs = 0;
  onDeliver: ((event: OutboxEvent) => void) | null = null;
  /** How many deliveries are in progress right now, and the most there ever were at once. */
  inFlight = 0;
  maxInFlight = 0;
  private readonly seen = new Set<string>();

  async deliver(event: OutboxEvent): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.deliverInner(event);
    } finally {
      this.inFlight--;
    }
  }

  private async deliverInner(event: OutboxEvent): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failAlways) throw this.failAlways;
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.deliveries.push(event.outboxId);
    this.onDeliver?.(event);
    if (this.seen.has(event.outboxId)) {
      this.duplicates++;
      return;
    }
    this.seen.add(event.outboxId);
    this.received.push(event);
  }
}

/** POSTs each event as JSON with an Outbox-Id header; the receiver dedupes on it. */
export class HttpNotificationSink implements NotificationSink {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number = DEFAULT_SINK_TIMEOUT_MS,
  ) {}

  async deliver(event: OutboxEvent): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'outbox-id': event.outboxId },
        body: JSON.stringify({ outboxId: event.outboxId, type: event.type, payload: event.payload, createdAt: event.createdAt.toISOString() }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SinkError(`sink unreachable: ${(err as Error).name}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new SinkError(`sink answered ${res.status}`);
  }
}
