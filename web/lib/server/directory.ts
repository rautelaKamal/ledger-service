import 'server-only';
import { PERSONAS, type Persona } from '@/lib/personas';
import { clientIdOf } from './identity';
import { getAccounts } from './ledger';

// Who a persona can pay: their own other accounts, the other demo people, and the
// fictional shops. Like account numbers on an invoice: paying TO an account is open
// (step 7a), spending FROM one is only for its owner.
export interface Payee {
  id: string;
  label: string;
  group: 'Your accounts' | 'People' | 'Shops';
}

export async function payeesFor(persona: Persona): Promise<Payee[]> {
  const others = PERSONAS.filter((p) => p.key !== persona.key);
  const [mine, people, shops] = await Promise.all([
    getAccounts(clientIdOf(persona)),
    Promise.all(others.map((p) => getAccounts(clientIdOf(p)))),
    getAccounts('demo-merchants'),
  ]);
  return [
    ...mine.map((a) => ({ id: a.id, label: `Your ${a.name.split(', ').at(-1)}`, group: 'Your accounts' as const })),
    ...people.flat().map((a) => ({ id: a.id, label: a.name, group: 'People' as const })),
    ...shops.map((a) => ({ id: a.id, label: a.name, group: 'Shops' as const })),
  ];
}
