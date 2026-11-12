// A stand-in for whoever consumes our events downstream (analytics, email,
// another service). The contract: events arrive AT LEAST once, so the consumer
// dedupes by outboxId. This is the consumer's half of that contract.
export interface SinkReceipt {
  duplicate: boolean;
}

export class SinkStore {
  private readonly seen = new Map<string, unknown>();
  duplicates = 0;

  record(outboxId: string, event: unknown): SinkReceipt {
    if (this.seen.has(outboxId)) {
      this.duplicates++;
      return { duplicate: true };
    }
    this.seen.set(outboxId, event);
    return { duplicate: false };
  }

  get count(): number {
    return this.seen.size;
  }
}
