import { Money } from '@/components/money';
import { ThemeToggle } from '@/components/theme-toggle';
import { PERSONAS } from '@/lib/personas';
import { reconciliationSentence } from '@/lib/server/describe';
import { clientIdOf } from '@/lib/server/identity';
import { getAccounts, getSystemStatus } from '@/lib/server/ledger';
import { sumPaise } from '@/lib/money';

export const dynamic = 'force-dynamic';

async function totals(): Promise<Map<string, bigint | null>> {
  const entries = await Promise.all(
    PERSONAS.map(async (p) => {
      try {
        const accounts = await getAccounts(clientIdOf(p));
        return [p.key, sumPaise(accounts.map((a) => a.balancePaise))] as const;
      } catch {
        return [p.key, null] as const;
      }
    }),
  );
  return new Map(entries);
}

export default async function PickPersona() {
  const [money, status] = await Promise.all([totals(), getSystemStatus().catch(() => null)]);
  const recon = reconciliationSentence(status);
  const ledgerDown = [...money.values()].every((v) => v === null);

  return (
    <main id="main" className="mx-auto max-w-5xl px-5 pt-10 pb-16 sm:px-8 sm:pt-16">
      <div className="flex items-start justify-between gap-4">
        <h1 className="max-w-[22ch] text-4xl leading-tight font-semibold sm:text-6xl sm:leading-[1.05]">Pick someone to be.</h1>
        <ThemeToggle />
      </div>
      <p className="mt-5 max-w-[60ch] text-lg text-ink-soft">
        Every rupee in this ledger is written twice, as a debit and a credit, and a request sent twice moves money once. Pick a person
        and try to break it.
      </p>
      <p className="mt-3 max-w-[60ch]">
        <span className="font-medium">{recon.headline}</span> <span className="text-ink-soft">{recon.detail}</span>
      </p>

      {ledgerDown ? (
        <p role="alert" className="mt-10 border-l-2 border-failed pl-3 text-failed">
          The ledger API did not answer, so the people and their balances cannot be shown. Start it and reload this page.
        </p>
      ) : null}

      <ul className="mt-10 grid gap-4 sm:grid-cols-3">
        {PERSONAS.map((p) => {
          const total = money.get(p.key);
          return (
            <li key={p.key}>
              <form action="/api/session" method="post" className="h-full">
                <input type="hidden" name="persona" value={p.key} />
                <button
                  type="submit"
                  className="group flex h-full w-full flex-col items-start gap-2 border border-rule bg-surface px-5 pt-4 pb-5 text-left transition-colors hover:border-ink focus-visible:border-ink"
                >
                  <span className="text-2xl font-semibold">{p.name}</span>
                  <span className="text-ink-soft">{p.blurb}</span>
                  <span className="mt-auto pt-3 font-figures text-2xl">{total == null ? 'balance unavailable' : <Money paise={total} />}</span>
                  <span className="text-sm text-ink-soft group-hover:text-ink">Continue as {p.firstName}</span>
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
