'use client';

import { useEffect, useState } from 'react';
import { Money } from '@/components/money';
import { Stamp } from '@/components/stamp';
import { Button } from '@/components/ui/button';
import { stampLabel } from '@/lib/dates';
import type { ReconciliationRun, SystemStatus } from '@/lib/types';
import type { ChaosResult } from '@/lib/server/chaos';

const CHECK_NAMES: Record<string, string> = {
  account_balances: 'Every balance equals the sum of its entries',
  posted_transactions_balanced: 'Every posted transaction has equal debits and credits',
  stale_pending_topups: 'No top-up has waited for the bank more than 24 hours',
  webhook_anomalies: 'No webhook disagreed with its top-up',
  outbox_problems: 'No outbox message is dead or stuck for an hour',
};

function useCountdown(initial: number): [number, (s: number) => void] {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, setLeft];
}

function RunResult({ run, land }: { run: ReconciliationRun; land: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        {run.problems === 0 ? (
          <Stamp land={land}>0 problems</Stamp>
        ) : (
          <span className="rounded-sm border border-failed px-2 py-0.5 text-failed">
            {run.problems} problem{run.problems === 1 ? '' : 's'}
          </span>
        )}
        <span className="text-ink-soft">
          {stampLabel(run.ranAt)}, {run.durationMs} ms
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {Object.entries(run.summary).map(([k, n]) => (
          <li key={k} className="flex gap-2">
            <span className={n === 0 ? 'text-money-in' : 'text-failed'} aria-hidden>
              {n === 0 ? '✓' : '✗'}
            </span>
            <span>
              {CHECK_NAMES[k] ?? k}
              <span className="sr-only">{n === 0 ? ': passed' : `: ${n} problems`}</span>
              {n > 0 ? <span className="text-failed">: {n}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SystemPanel({ initial }: { initial: SystemStatus }) {
  const [status, setStatus] = useState(initial);
  const [lastRun, setLastRun] = useState<{ run: ReconciliationRun; fresh: boolean } | null>(initial.lastReconciliation ? { run: initial.lastReconciliation, fresh: false } : null);
  const [reconWait, setReconWait] = useCountdown(initial.retryAfterSeconds.reconcile);
  const [chaosWait, setChaosWait] = useCountdown(initial.retryAfterSeconds.chaos);
  const [busy, setBusy] = useState<'reconcile' | 'chaos' | null>(null);
  const [chaos, setChaos] = useState<Extract<ChaosResult, { ok: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const res = await fetch('/api/system', { cache: 'no-store' });
    if (res.ok) setStatus((await res.json()) as SystemStatus);
  }

  async function act(kind: 'reconcile' | 'chaos'): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/system/${kind}`, { method: 'POST' });
      const body = (await res.json()) as { error?: string; retryAfterSeconds?: number; run?: ReconciliationRun } & Partial<Extract<ChaosResult, { ok: true }>>;
      if (res.status === 429) {
        (kind === 'reconcile' ? setReconWait : setChaosWait)(body.retryAfterSeconds ?? status.cooldownSeconds);
        setError(body.error ?? 'Try again in a minute.');
        return;
      }
      if (!res.ok) {
        setError(`It did not run: ${body.error ?? res.status}.`);
        return;
      }
      if (kind === 'reconcile' && body.run) {
        setLastRun({ run: body.run, fresh: true });
        setReconWait(status.cooldownSeconds);
      }
      if (kind === 'chaos' && body.reconciliation) {
        setChaos(body as Extract<ChaosResult, { ok: true }>);
        setLastRun({ run: body.reconciliation, fresh: true });
        setChaosWait(status.cooldownSeconds);
      }
      await refresh();
    } catch {
      setError('The web server did not answer.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <section aria-labelledby="outbox-heading" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="outbox-heading" className="text-2xl font-semibold">
            Outbox
          </h2>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
        <p className="max-w-[62ch] text-ink-soft">
          Work that must happen after a commit (asking the bank for a payment, sending notifications) is written in the same transaction as the money, then
          delivered by a worker. Two lanes, so a backlog of notifications never delays a payment.
        </p>
        <table className="w-full border-collapse">
          <caption className="sr-only">Outbox lanes, as of {stampLabel(status.checkedAt)}</caption>
          <thead>
            <tr className="border-b-2 border-ink text-left text-sm text-ink-soft">
              <th scope="col" className="py-2 pr-3 font-medium">Lane</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Waiting</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Oldest waiting</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Delivered, last hour</th>
              <th scope="col" className="py-2 text-right font-medium">Dead</th>
            </tr>
          </thead>
          <tbody>
            {status.lanes.map((l) => (
              <tr key={l.lane} className="border-b border-rule">
                <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                  {l.lane === 'commands' ? 'Commands (payments)' : 'Events (notifications)'}
                </th>
                <td className="money py-2.5 pr-3 text-right">{l.pending}</td>
                <td className="money py-2.5 pr-3 text-right">{l.oldestPendingSeconds === null ? 'none' : `${l.oldestPendingSeconds} s`}</td>
                <td className="money py-2.5 pr-3 text-right">{l.sentLastHour}</td>
                <td className={`money py-2.5 text-right ${l.dead > 0 ? 'text-failed' : ''}`}>{l.dead}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="recon-heading" className="flex flex-col gap-3">
        <h2 id="recon-heading" className="text-2xl font-semibold">
          Reconciliation
        </h2>
        <p className="max-w-[62ch] text-ink-soft">
          Five checks, read-only, over the whole ledger. {status.reconciliationRunsLast7Days} run{status.reconciliationRunsLast7Days === 1 ? '' : 's'} recorded in the
          last 7 days here.
        </p>
        {lastRun ? <RunResult run={lastRun.run} land={lastRun.fresh} /> : <p>It has not run in this environment yet.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => void act('reconcile')} disabled={busy !== null || reconWait > 0}>
            {busy === 'reconcile' ? 'Checking every account…' : 'Run reconciliation now'}
          </Button>
          {reconWait > 0 ? <span className="text-sm text-ink-soft">Available again in {reconWait} s (once a minute).</span> : null}
        </div>
      </section>

      <section aria-labelledby="chaos-heading" className="flex flex-col gap-3 border-t-2 border-ink pt-6">
        <h2 id="chaos-heading" className="text-2xl font-semibold">
          Try to break it
        </h2>
        <p className="max-w-[62ch] text-ink-soft">
          200 transfers of ₹1.00 at the same moment, half one way and half the other, between two test accounts that belong to nobody you can pick. They all
          fight over the same two rows. Then reconciliation checks the whole ledger.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={() => void act('chaos')} disabled={busy !== null || chaosWait > 0}>
            {busy === 'chaos' ? 'Sending 200 transfers…' : 'Run 200 concurrent transfers'}
          </Button>
          {chaosWait > 0 ? <span className="text-sm text-ink-soft">Available again in {chaosWait} s (once a minute, for everyone).</span> : null}
        </div>
        {chaos ? (
          <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-1" aria-live="polite">
            <dt className="text-ink-soft">Transfers sent at once</dt>
            <dd className="money">{chaos.transfers}</dd>
            <dt className="text-ink-soft">Answers</dt>
            <dd className="money">
              {Object.entries(chaos.statuses)
                .map(([s, n]) => `${n} × ${s === '201' ? '201 Created' : s === '201 replayed' ? '201, answered from the record after a retried connection' : s}`)
                .join(', ')}
            </dd>
            <dt className="text-ink-soft">Response time</dt>
            <dd className="money">
              median {chaos.p50Ms} ms, 95th percentile {chaos.p95Ms} ms, all done in {chaos.wallMs} ms
            </dd>
            <dt className="text-ink-soft">The two accounts together</dt>
            <dd>
              <Money paise={chaos.pairBefore} /> before, <Money paise={chaos.pairAfter} /> after
              {chaos.pairBefore === chaos.pairAfter ? ': not a paisa created or lost' : ': THEY DIFFER'}
            </dd>
          </dl>
        ) : null}
      </section>

      {error ? (
        <p role="alert" className="border-l-2 border-failed pl-3 text-failed">
          {error}
        </p>
      ) : null}
    </div>
  );
}
