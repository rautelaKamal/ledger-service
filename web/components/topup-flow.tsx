'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { secondsLabel } from '@/lib/dates';
import { formatPaise, parseRupees } from '@/lib/money';
import type { Account, Topup } from '@/lib/types';
import { cn } from '@/lib/utils';

const POLL_MS = 1_500;
const GIVE_UP_MS = 120_000;

type StepState = 'done' | 'current' | 'waiting' | 'failed';

function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: React.ReactNode }) {
  return (
    <li className="relative grid grid-cols-[2rem_1fr] gap-x-3 pb-6 last:pb-0">
      <span
        aria-hidden
        className={cn(
          'flex size-8 items-center justify-center rounded-full border-2 font-figures text-lg',
          state === 'done' && 'border-ink bg-ink text-paper',
          state === 'current' && 'hatch border-pending text-pending',
          state === 'waiting' && 'border-rule text-ink-soft',
          state === 'failed' && 'border-failed text-failed',
        )}
      >
        {n}
      </span>
      <div className="pt-0.5">
        <p className={cn('font-medium', state === 'waiting' && 'text-ink-soft')}>
          {title}
          <span className="sr-only">: {state === 'done' ? 'done' : state === 'current' ? 'in progress' : state === 'failed' ? 'failed' : 'not yet'}</span>
        </p>
        {children ? <div className="text-ink-soft">{children}</div> : null}
      </div>
    </li>
  );
}

export function TopupFlow({ accounts, initialTopupId, initialKey }: { accounts: Account[]; initialTopupId?: string; initialKey: string }) {
  const router = useRouter();
  const ids = useId();
  const [account, setAccount] = useState(accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [topupId, setTopupId] = useState<string | undefined>(initialTopupId);
  const [topup, setTopup] = useState<Topup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bankSent, setBankSent] = useState<'succeed' | 'fail' | null>(null);
  const [stalled, setStalled] = useState(false);
  // A new top-up needs a new key; reusing one would replay the previous request.
  const [key, setKey] = useState(initialKey);
  const started = useRef(0);
  const done = useRef(false);
  const paise = parseRupees(amount);

  const poll = useCallback(async () => {
    if (!topupId) return;
    const res = await fetch(`/api/topups/${topupId}`, { cache: 'no-store' });
    if (res.status === 404) return setError('This top-up does not belong to the person you are now, or does not exist.');
    if (!res.ok) return; // keep the last known state; the next poll tries again
    const t = (await res.json()) as Topup;
    setTopup(t);
    if (t.status !== 'pending' && !done.current) {
      done.current = true; // stop polling: a final top-up never changes again
      router.refresh();
    }
  }, [topupId, router]);

  useEffect(() => {
    if (!topupId) return;
    started.current = Date.now();
    const first = setTimeout(() => void poll(), 0);
    const timer = setInterval(() => {
      if (done.current) return clearInterval(timer);
      if (Date.now() - started.current > GIVE_UP_MS) {
        setStalled(true);
        clearInterval(timer);
        return;
      }
      void poll();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [topupId, poll]);

  const final = topup?.status === 'posted' || topup?.status === 'failed';

  async function request(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!paise) return setError('Enter an amount in rupees, for example 5,000.00.');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/topups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: account, amountPaise: paise.toString(), idempotencyKey: key }),
      });
      const body = (await res.json()) as { topupId: string | null; error?: string; exchange?: { response: { status: number; body: { error?: { message?: string } } } } };
      if (!res.ok || !body.topupId) {
        setError(`The top-up was not requested: ${body.exchange?.response.body.error?.message ?? body.error ?? 'unknown error'}.`);
        return;
      }
      setTopupId(body.topupId);
    } catch {
      setError('The web server did not answer. Request the top-up again; the same key cannot create two.');
    } finally {
      setBusy(false);
    }
  }

  async function bank(outcome: 'succeed' | 'fail'): Promise<void> {
    setError(null);
    const res = await fetch(`/api/topups/${topupId}/bank`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome }) });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(`The bank did not take that: ${body.error ?? res.status}.`);
      return;
    }
    setBankSent(outcome);
  }

  if (!topupId) {
    return (
      <form onSubmit={request} className="flex max-w-xl flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-amount`}>Amount in rupees</Label>
          <Input id={`${ids}-amount`} inputMode="decimal" placeholder="5,000.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="money h-10 w-40" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-account`}>To</Label>
          <select id={`${ids}-account`} value={account} onChange={(e) => setAccount(e.target.value)} className="h-10 rounded-md border border-input bg-surface px-3">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name.split(', ').at(-1)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="lg" className="h-10" disabled={busy}>
          {busy ? 'Requesting…' : paise ? `Request a ${formatPaise(paise)} top-up` : 'Request top-up'}
        </Button>
        {error ? (
          <p role="alert" className="w-full border-l-2 border-failed pl-3 text-failed">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  const webhook = topup?.webhooks[0];
  const paid = Boolean(topup?.providerPaymentId);
  return (
    <div className="flex max-w-2xl flex-col gap-6" aria-live="polite">
      <p>
        {topup ? (
          <>
            Top-up of <Money paise={topup.amountPaise} className="font-medium" />, id <code className="money">{topup.topupId.slice(0, 8)}…</code>
          </>
        ) : (
          'Loading the top-up…'
        )}
      </p>
      <ol>
        <Step n={1} title="Requested" state={topup ? 'done' : 'current'}>
          {topup ? `${secondsLabel(topup.createdAt)} IST: 202 Accepted. Nothing is credited yet; the API only recorded the request and queued a payment command.` : null}
        </Step>
        <Step n={2} title="Payment created" state={paid ? 'done' : 'current'}>
          {paid ? (
            <>
              {topup?.paymentSentAt ? `${secondsLabel(topup.paymentSentAt)} IST: ` : ''}the worker delivered the payment command through the outbox&rsquo;s command lane;
              the provider opened payment <code className="money">{topup?.providerPaymentId}</code>.
            </>
          ) : (
            'Waiting for the worker to pick up the payment command.'
          )}
        </Step>
        <Step n={3} title="The bank confirms" state={webhook || final ? 'done' : paid ? 'current' : 'waiting'}>
          {!webhook && !final && paid ? (
            <div className="mt-2 flex flex-col gap-2">
              <p>In real life the bank decides. Here you do; these buttons tell the mock provider what to answer.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void bank('succeed')} disabled={bankSent !== null}>
                  Approve as the bank
                </Button>
                <Button variant="outline" onClick={() => void bank('fail')} disabled={bankSent !== null}>
                  Decline as the bank
                </Button>
              </div>
              {bankSent ? <p>Sent to the provider; its webhook is on its way.</p> : null}
            </div>
          ) : webhook ? (
            `The provider reported ${webhook.type === 'payment.succeeded' ? 'success' : 'a failure'}.`
          ) : null}
        </Step>
        <Step n={4} title="Webhook received" state={webhook ? 'done' : 'waiting'}>
          {webhook ? (
            <>
              {secondsLabel(webhook.receivedAt)} IST: event <code className="money">{webhook.eventId}</code>, signature checked, recorded once.
              {topup && topup.webhooks.length > 1 ? ` ${topup.webhooks.length - 1} more deliveries of events were recorded and ignored as duplicates or late.` : ''}
            </>
          ) : null}
        </Step>
        <Step n={5} title={topup?.status === 'failed' ? 'Failed' : 'Posted'} state={topup?.status === 'posted' ? 'done' : topup?.status === 'failed' ? 'failed' : 'waiting'}>
          {topup?.status === 'posted' && topup.postedAt ? (
            <>
              {secondsLabel(topup.postedAt)} IST: <Money paise={topup.amountPaise} signed /> entered in the passbook, balanced against the bank settlement account.
            </>
          ) : topup?.status === 'failed' ? (
            'Nothing was credited and no entry was written. The passbook shows it struck through.'
          ) : null}
        </Step>
      </ol>
      {stalled && !final ? (
        <p role="alert" className="border-l-2 border-pending pl-3">
          Two minutes without a final answer. Check that the worker (step 2) and the mock provider (step 3) are running; this page stopped asking.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="border-l-2 border-failed pl-3 text-failed">
          {error}
        </p>
      ) : null}
      {final ? (
        <div>
          <Button
            variant="outline"
            onClick={() => {
              done.current = false;
              setTopup(null);
              setTopupId(undefined);
              setBankSent(null);
              setStalled(false);
              setError(null);
              setAmount('');
              setKey(`web-topup-${crypto.randomUUID()}`);
              router.replace('/topup');
            }}
          >
            Add money again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
