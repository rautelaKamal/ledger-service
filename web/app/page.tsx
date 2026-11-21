import { DemoBanner } from '@/components/demo-banner';
import { Money } from '@/components/money';
import { SecurityArt } from '@/components/security-print';
import { ThemeToggle } from '@/components/theme-toggle';
import { PERSONAS, tintStyle } from '@/lib/personas';
import { reconciliationSentence } from '@/lib/server/describe';
import { clientIdOf } from '@/lib/server/identity';
import { getAccounts, getSystemStatus } from '@/lib/server/ledger';
import { sumPaise } from '@/lib/money';

export const dynamic = 'force-dynamic';

interface Holdings {
  total: bigint;
  accounts: string[];
}

async function holdings(): Promise<Map<string, Holdings | null>> {
  const entries = await Promise.all(
    PERSONAS.map(async (p) => {
      try {
        const accounts = await getAccounts(clientIdOf(p));
        return [p.key, { total: sumPaise(accounts.map((a) => a.balancePaise)), accounts: accounts.map((a) => a.name.split(', ').at(-1) ?? a.name) }] as const;
      } catch {
        return [p.key, null] as const;
      }
    }),
  );
  return new Map(entries);
}

export default async function PickPersona() {
  const [money, status] = await Promise.all([holdings(), getSystemStatus().catch(() => null)]);
  const recon = reconciliationSentence(status);
  const ledgerDown = [...money.values()].every((v) => v === null);

  return (
    <>
    <DemoBanner />
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

      {/* Each person is a cheque leaf: a counterfoil, a perforation, and the leaf with
          their own security print. Distinct by tint and content, not a card grid.
          The link is the line at the foot of the leaf, "Continue as <person>": its
          name is exactly what it shows (WCAG 2.5.3), the rest of the leaf is its
          description, and its click area stretches over the whole slip (.slip-link).
          A plain link: GET /api/session sets the persona and redirects. Keep it a plain
          <a>, never next/link: a Link prefetches its target (in view or on hover), and
          prefetching this one would switch the person behind their back (test 18). */}
      <ul className="mt-10 flex max-w-3xl flex-col gap-5">
        {PERSONAS.map((p) => {
          const h = money.get(p.key);
          const id = (part: string) => `persona-${p.key}-${part}`;
          return (
            <li
              key={p.key}
              data-persona-scope
              style={tintStyle(p)}
              className="group relative grid border border-rule bg-surface transition-colors hover:border-ink has-[a:focus-visible]:border-ink sm:grid-cols-[10rem_1fr]"
            >
              <div className="flex flex-col gap-1 border-b-2 border-dashed border-rule px-4 py-3 text-sm text-ink-soft sm:row-span-2 sm:border-r-2 sm:border-b-0">
                <p id={id('accounts')} className="text-ink">
                  {h ? h.accounts.join(' and ') : 'accounts unavailable'}
                </p>
              </div>
              <div className="security flex flex-col gap-2 border-y-0 px-5 pt-4 pb-3">
                <SecurityArt persona={p} />
                <p className="text-2xl font-semibold">{p.name}</p>
                <p id={id('blurb')} className="text-ink-soft">
                  {p.blurb}
                </p>
                <p id={id('balance')} className="mt-1 font-figures text-2xl">
                  {h ? (
                    <span className="amount-box inline-block">
                      <Money paise={h.total} />
                    </span>
                  ) : (
                    'balance unavailable'
                  )}
                </p>
              </div>
              <a
                href={`/api/session?persona=${p.key}`}
                aria-describedby={`${id('accounts')} ${id('blurb')} ${id('balance')}`}
                className="slip-link px-5 pt-2 pb-5 text-lg font-medium text-ink underline decoration-tint-ink decoration-2 underline-offset-[5px] group-hover:decoration-[3px]"
              >
                Continue as {p.name}
              </a>
            </li>
          );
        })}
      </ul>
    </main>
    </>
  );
}
