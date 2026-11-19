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
          their own security print. Distinct by tint and content, not a card grid. */}
      <ul className="mt-10 flex max-w-3xl flex-col gap-5">
        {PERSONAS.map((p) => {
          const h = money.get(p.key);
          return (
            <li key={p.key} style={tintStyle(p)}>
              <form action="/api/session" method="post">
                <input type="hidden" name="persona" value={p.key} />
                <button
                  type="submit"
                  className="group grid w-full border border-rule bg-surface text-left transition-colors hover:border-ink focus-visible:border-ink sm:grid-cols-[10rem_1fr]"
                >
                  <span className="flex flex-col gap-1 border-b-2 border-dashed border-rule px-4 py-3 text-sm text-ink-soft sm:border-r-2 sm:border-b-0">
                    <span className="text-ink">{h ? h.accounts.join(' and ') : 'accounts unavailable'}</span>
                  </span>
                  <span className="security flex flex-col gap-2 border-y-0 px-5 pt-4 pb-5">
                    <SecurityArt persona={p} />
                    <span className="text-2xl font-semibold">{p.name}</span>
                    <span className="text-ink-soft">{p.blurb}</span>
                    <span className="mt-1 font-figures text-2xl">
                      {h ? (
                        <span className="amount-box inline-block">
                          <Money paise={h.total} />
                        </span>
                      ) : (
                        'balance unavailable'
                      )}
                    </span>
                    <span className="text-sm text-ink-soft group-hover:text-ink">Continue as {p.firstName}</span>
                  </span>
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
