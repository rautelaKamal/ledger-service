import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BalanceChart } from '@/components/balance-chart';
import { Money } from '@/components/money';
import { Notice } from '@/components/notice';
import { Passbook } from '@/components/passbook';
import { ago } from '@/lib/dates';
import { sumPaise } from '@/lib/money';
import { clientIdOf, currentPersona } from '@/lib/server/identity';
import { getAccounts, getBalanceHistory, getPassbook } from '@/lib/server/ledger';
import type { BalanceDay, PassbookRow } from '@/lib/types';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Overview' };

const shortName = (name: string) => name.split(', ').at(-1) ?? name;

function sumHistories(histories: BalanceDay[][]): BalanceDay[] {
  const first = histories[0] ?? [];
  return first.map((d, i) => ({ day: d.day, balancePaise: sumPaise(histories.map((h) => h[i]?.balancePaise ?? '0')).toString() }));
}

export default async function Overview({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const persona = await currentPersona();
  if (!persona) redirect('/');
  const clientId = clientIdOf(persona);

  let accounts;
  try {
    accounts = await getAccounts(clientId);
  } catch {
    return <Notice tone="error" title="The ledger API did not answer.">Your balance cannot be shown right now. Reload the page once the API is running.</Notice>;
  }
  if (accounts.length === 0) return <Notice title={`${persona.firstName} has no accounts yet.`}>Run the demo seed (npm run seed:demo) and reload.</Notice>;

  const { account: wanted } = await searchParams;
  const selected = accounts.find((a) => a.id === wanted) ?? accounts[0]!;
  const [histories, firstPages, passbook] = await Promise.all([
    Promise.all(accounts.map((a) => getBalanceHistory(clientId, a.id, 30))),
    Promise.all(accounts.filter((a) => a.pendingTopups > 0).map((a) => getPassbook(clientId, a.id, undefined, 50).then((p) => ({ account: a, rows: p.transactions })))),
    getPassbook(clientId, selected.id),
  ]);
  const total = sumPaise(accounts.map((a) => a.balancePaise));
  const pending: Array<PassbookRow & { accountName: string }> = firstPages.flatMap(({ account, rows }) =>
    rows.filter((r) => r.status === 'pending').map((r) => ({ ...r, accountName: shortName(account.name) })),
  );

  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <section aria-labelledby="balance-heading">
        <h1 id="balance-heading" className="text-lg text-ink-soft">
          {persona.firstName}&rsquo;s money
        </h1>
        <p className="mt-1 font-figures text-4xl leading-none font-semibold sm:text-6xl">
          <Money paise={total} />
        </p>
        <p className="mt-2 text-ink-soft">
          {accounts.length === 1 ? `in ${shortName(accounts[0]!.name)}` : `across ${accounts.map((a) => shortName(a.name)).join(' and ')}`}
          {accounts.length > 1 ? (
            <>
              {': '}
              {accounts.map((a, i) => (
                <span key={a.id}>
                  {i > 0 ? ', ' : ''}
                  {shortName(a.name)} <Money paise={a.balancePaise} />
                </span>
              ))}
            </>
          ) : null}
        </p>
      </section>

      <section aria-labelledby="transit-heading" className={cn('border px-4 py-3', pending.length ? 'border-pending' : 'border-rule')}>
        <h2 id="transit-heading" className="font-medium">
          In transit, not in your balance
        </h2>
        {pending.length === 0 ? (
          <p className="mt-1 text-ink-soft">
            Nothing is waiting for the bank. <Link href="/topup" className="underline underline-offset-4">Add money</Link> to see a top-up travel.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Money paise={p.amountPaise} className="hatch px-1 font-medium text-pending" />
                <span>top-up to {p.accountName}, waiting for the bank</span>
                <span className="text-sm text-ink-soft">{ago(p.createdAt)}</span>
                <Link href={`/topup?id=${p.id}`} className="text-sm underline underline-offset-4">
                  Follow it
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BalanceChart days={sumHistories(histories)} />

      <section aria-labelledby="passbook-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="passbook-heading" className="text-2xl font-semibold">
            Passbook
          </h2>
          {accounts.length > 1 ? (
            <nav aria-label="Account" className="flex gap-1">
              {accounts.map((a) => (
                <Link
                  key={a.id}
                  href={`/overview?account=${a.id}`}
                  aria-current={a.id === selected.id ? 'true' : undefined}
                  className={cn('border-b-2 px-2 py-1', a.id === selected.id ? 'border-ink font-medium' : 'border-transparent text-ink-soft hover:text-ink')}
                >
                  {shortName(a.name)}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
        <Passbook key={selected.id} accountId={selected.id} initial={passbook} />
      </section>
    </div>
  );
}
