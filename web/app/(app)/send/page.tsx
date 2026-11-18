import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { Notice } from '@/components/notice';
import { SendForm } from '@/components/send-form';
import { payeesFor } from '@/lib/server/directory';
import { clientIdOf, currentPersona } from '@/lib/server/identity';
import { getAccounts } from '@/lib/server/ledger';

export const metadata: Metadata = { title: 'Send money' };

export default async function SendPage() {
  const persona = await currentPersona();
  if (!persona) redirect('/');
  let data;
  try {
    data = await Promise.all([getAccounts(clientIdOf(persona)), payeesFor(persona)]);
  } catch {
    return <Notice tone="error" title="The ledger API did not answer.">Accounts cannot be listed, so nothing can be sent. Reload once the API is running.</Notice>;
  }
  const [accounts, payees] = data;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-4xl font-semibold">Send money</h1>
        <p className="mt-2 max-w-[60ch] text-ink-soft">
          A transfer is posted the moment it is accepted: one debit, one credit, in one database transaction. Send one, then send exactly the same request again.
        </p>
      </div>
      <SendForm accounts={accounts} payees={payees} initialKey={`web-${randomUUID()}`} />
    </div>
  );
}
