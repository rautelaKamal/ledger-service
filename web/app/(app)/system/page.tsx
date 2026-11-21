import type { Metadata } from 'next';
import { Notice } from '@/components/notice';
import { SystemPanel } from '@/components/system-panel';
import { reconciliationSentence } from '@/lib/server/describe';
import { env } from '@/lib/server/env';
import { getSystemStatus } from '@/lib/server/ledger';

export const metadata: Metadata = { title: 'Under the hood' };

export default async function SystemPage() {
  const status = await getSystemStatus().catch(() => null);
  const recon = reconciliationSentence(status);
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-4xl font-semibold">Under the hood</h1>
        <p className="mt-2 max-w-[62ch] text-ink-soft">
          {recon.headline} {recon.detail}
        </p>
        <p className="mt-2 text-ink-soft">
          {env.GRAFANA_URL ? (
            <a href={env.GRAFANA_URL} className="text-ink underline underline-offset-4" target="_blank" rel="noreferrer">
              Grafana dashboard (opens in a new tab)
            </a>
          ) : (
            'Grafana is not linked in this environment.'
          )}
          {env.PROMETHEUS_URL ? (
            <>
              {' '}
              <a href={env.PROMETHEUS_URL} className="text-ink underline underline-offset-4" target="_blank" rel="noreferrer">
                Prometheus targets
              </a>
            </>
          ) : null}
        </p>
      </div>
      {status ? (
        <SystemPanel initial={status} />
      ) : (
        <Notice tone="error" title="The ledger's internal port did not answer.">
          This page reads the outbox and reconciliation through the API&rsquo;s internal port (9100), which needs RECONCILER_DATABASE_URL on the API.
        </Notice>
      )}
    </div>
  );
}
