import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { Notice } from '@/components/notice';
import { TopupFlow } from '@/components/topup-flow';
import { clientIdOf, currentPersona } from '@/lib/server/identity';
import { getAccounts } from '@/lib/server/ledger';

export const metadata: Metadata = { title: 'Top up' };

export default async function TopupPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const persona = await currentPersona();
  if (!persona) redirect('/');
  let accounts;
  try {
    accounts = await getAccounts(clientIdOf(persona));
  } catch {
    return <Notice tone="error" title="The ledger API did not answer.">Reload once the API is running.</Notice>;
  }
  const { id } = await searchParams;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-4xl font-semibold">Add money</h1>
        <p className="mt-2 max-w-[60ch] text-ink-soft">
          A top-up is not money until the bank says so. It waits as pending, outside your balance, until the provider&rsquo;s signed webhook arrives.
        </p>
      </div>
      <TopupFlow key={id ?? 'new'} accounts={accounts} initialTopupId={id} initialKey={`web-topup-${randomUUID()}`} />
    </div>
  );
}
