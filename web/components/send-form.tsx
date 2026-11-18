'use client';

import { Copy, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Money } from '@/components/money';
import { Stamp } from '@/components/stamp';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WirePanel } from '@/components/wire-panel';
import { formatPaise, parseRupees } from '@/lib/money';
import type { Account, WireExchange } from '@/lib/types';
import type { Payee } from '@/lib/server/directory';

interface Result {
  exchange: WireExchange;
  fromBalanceBefore: string | null;
  fromBalanceAfter: string | null;
}

const short = (id: string) => `${id.slice(0, 4)}…${id.slice(-4)}`;

// The ledger's error codes, said plainly. Unknown codes fall back to the API's own message.
const REASONS: Record<string, string> = {
  insufficient_funds: 'there is not enough money in this account',
  account_not_found: 'one of the accounts does not exist',
  currency_mismatch: 'the two accounts hold different currencies',
  same_account: 'an account cannot send money to itself',
  idempotency_key_reused: 'this key was already used for a different request',
};
const selectClass = 'w-full rounded-md border border-input bg-surface px-3 py-2';

export function SendForm({ accounts, payees, initialKey }: { accounts: Account[]; payees: Payee[]; initialKey: string }) {
  const router = useRouter();
  const ids = useId();
  const [key, setKey] = useState(initialKey);
  const [from, setFrom] = useState(accounts[0]?.id ?? '');
  const [to, setTo] = useState(payees.find((p) => p.group !== 'Your accounts')?.id ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [first, setFirst] = useState<Result | null>(null);
  const [replay, setReplay] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paise = parseRupees(amount);
  const locked = first !== null; // after sending, the request is fixed: "again" must be the SAME request
  const fromAccount = accounts.find((a) => a.id === from);
  const accountName = (fromAccount?.name.split(', ').at(-1) ?? 'Account');

  async function send(): Promise<Result | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromAccountId: from, toAccountId: to, amountPaise: paise?.toString(), note: note || undefined, idempotencyKey: key }),
      });
      const body = (await res.json()) as Result | { error: string };
      if (!res.ok || 'error' in body) {
        setError('error' in body ? `The transfer was not sent: ${body.error}.` : 'The transfer was not sent.');
        return null;
      }
      return body;
    } catch {
      setError('The web server did not answer. Check your connection and send again; the same key cannot move money twice.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!paise) return setError('Enter an amount in rupees, for example 1,200.00.');
    if (from === to) return setError('Choose a different account to send to.');
    const r = await send();
    if (r) {
      setFirst(r);
      router.refresh();
    }
  }

  function startOver(): void {
    setFirst(null);
    setReplay(null);
    setError(null);
    setAmount('');
    setNote('');
    setKey(crypto.randomUUID());
  }

  const status = (r: Result) => r.exchange.response.status;
  const replayed = replay?.exchange.response.headers['idempotent-replayed'] === 'true';
  const refusal = first && status(first) >= 400 ? (first.exchange.response.body as { error?: { code?: string; message?: string } } | null)?.error : null;
  const apiError = refusal ? (REASONS[refusal.code ?? ''] ?? refusal.message ?? 'the ledger refused it') : null;

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <form onSubmit={onSubmit} className="grid gap-5 sm:grid-cols-2" aria-describedby={`${ids}-key`}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-from`}>From</Label>
          <select id={`${ids}-from`} className={selectClass} value={from} onChange={(e) => setFrom(e.target.value)} disabled={locked}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name.split(', ').at(-1)}, {formatPaise(a.balancePaise)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-to`}>To</Label>
          <select id={`${ids}-to`} className={selectClass} value={to} onChange={(e) => setTo(e.target.value)} disabled={locked}>
            {(['Your accounts', 'People', 'Shops'] as const).map((g) => (
              <optgroup key={g} label={g}>
                {payees
                  .filter((p) => p.group === g && p.id !== from)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-amount`}>Amount in rupees</Label>
          <Input
            id={`${ids}-amount`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="1,200.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={locked}
            className="money"
            aria-invalid={amount !== '' && !paise}
          />
          {amount !== '' && paise ? <span className="text-sm text-ink-soft">{formatPaise(paise)}</span> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-note`}>Note, optional</Label>
          <Input id={`${ids}-note`} maxLength={140} placeholder="rent share" value={note} onChange={(e) => setNote(e.target.value)} disabled={locked} />
        </div>

        <div id={`${ids}-key`} className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-span-2">
          <span className="text-ink-soft">Idempotency key</span>
          <code className="money break-all">{key}</code>
          <Button type="button" variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(key)} aria-label="Copy the idempotency key">
            <Copy className="size-4" aria-hidden /> Copy
          </Button>
          {!locked ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setKey(crypto.randomUUID())}>
              <RefreshCw className="size-4" aria-hidden /> New key
            </Button>
          ) : null}
          <p className="w-full text-sm text-ink-soft">A new key for every new transfer. The same key sent again returns the first answer and moves nothing.</p>
        </div>

        {!locked ? (
          <div className="sm:col-span-2">
            <Button type="submit" size="lg" disabled={busy}>
              {busy ? 'Sending…' : paise ? `Send ${formatPaise(paise)}` : 'Send'}
            </Button>
          </div>
        ) : null}
      </form>

      {error ? (
        <p role="alert" className="border-l-2 border-failed pl-3 text-failed">
          {error}
        </p>
      ) : null}

      {first ? (
        <section aria-live="polite" className="flex flex-col gap-4 border-t-2 border-ink pt-5">
          {apiError ? (
            <p role="alert" className="text-failed">
              Refused: {apiError} ({status(first)} <code>{refusal?.code}</code>). Nothing moved.
            </p>
          ) : (
            <>
              <p className="text-lg">
                <span className="font-semibold">Sent.</span> {status(first)} Created, transaction{' '}
                <code className="money">{short(String((first.exchange.response.body as { transactionId?: string })?.transactionId ?? ''))}</code>
              </p>
              {first.fromBalanceBefore && first.fromBalanceAfter ? (
                <p>
                  {accountName} <Money paise={first.fromBalanceBefore} /> became <Money paise={first.fromBalanceAfter} />
                </p>
              ) : null}
            </>
          )}

          {!replay ? (
            <div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  const r = await send();
                  if (r) setReplay(r);
                }}
              >
                {busy ? 'Sending again…' : 'Send the same request again'}
              </Button>
              <p className="mt-1 text-sm text-ink-soft">Same key, same body: what a phone does when the network drops and it retries.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {replayed && replay.fromBalanceAfter === first.fromBalanceAfter ? (
                <div className="flex flex-wrap items-center gap-4">
                  <Stamp land>Replayed, no new money moved</Stamp>
                  <p className="text-ink-soft">
                    {status(replay)} with <code>Idempotent-Replayed: true</code>, the same body, and {accountName} still at{' '}
                    {replay.fromBalanceAfter ? <Money paise={replay.fromBalanceAfter} /> : null}.
                  </p>
                </div>
              ) : (
                <p role="alert" className="text-failed">
                  The second request was answered {status(replay)} without the replay header. Look at both responses below.
                </p>
              )}
              <WirePanel exchange={replay.exchange} />
            </div>
          )}
          <WirePanel exchange={first.exchange} />
          <div>
            <Button variant="ghost" onClick={startOver}>
              Start a new transfer
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
