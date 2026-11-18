// Shapes the web server passes to the browser. No client ids, no internal URLs.

export interface Account {
  id: string;
  name: string;
  currency: string;
  balancePaise: string;
  createdAt: string;
  pendingTopups: number;
  pendingTopupsPaise: string;
}

export interface PassbookRow {
  id: string;
  kind: 'transfer' | 'topup' | 'refund';
  status: 'pending' | 'posted' | 'failed';
  note: string | null;
  createdAt: string;
  postedAt: string | null;
  amountPaise: string;
  balanceAfterPaise: string | null;
  counterparty: { name: string; isMine: boolean } | null;
}

export interface PassbookPage {
  transactions: PassbookRow[];
  nextCursor: string | null;
}

export interface BalanceDay {
  day: string;
  balancePaise: string;
}

export interface Topup {
  topupId: string;
  accountId: string;
  currency: string;
  amountPaise: string;
  status: 'pending' | 'posted' | 'failed';
  createdAt: string;
  postedAt: string | null;
  providerPaymentId: string | null;
  /** When the worker delivered the payment command to the provider (outbox sent_at). */
  paymentSentAt: string | null;
  webhooks: Array<{ eventId: string; type: string; result: string; receivedAt: string }>;
}

export interface LaneStatus {
  lane: 'commands' | 'events';
  pending: number;
  oldestPendingSeconds: number | null;
  dead: number;
  sentLastHour: number;
}

export interface ReconciliationRun {
  id: string;
  ranAt: string;
  ok: boolean;
  durationMs: number;
  problems: number;
  summary: Record<string, number>;
}

export interface SystemStatus {
  checkedAt: string;
  lanes: LaneStatus[];
  lastReconciliation: ReconciliationRun | null;
  reconciliationRunsLast7Days: number;
  cooldownSeconds: number;
  retryAfterSeconds: { reconcile: number; chaos: number };
}

/** What a request to the ledger looked like, for the Send page's "as the server sent it" panel. */
export interface WireExchange {
  request: { method: string; path: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown; ms: number };
}
