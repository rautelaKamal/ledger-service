import { NextResponse } from 'next/server';
import { currentPersona } from '@/lib/server/identity';
import { reconcileNow, retryAfterOf } from '@/lib/server/ledger';

// Run every reconciliation check now. The API allows one start per cooldown, across replicas.
export async function POST(): Promise<NextResponse> {
  if (!(await currentPersona())) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  try {
    return NextResponse.json(await reconcileNow());
  } catch (err) {
    const wait = retryAfterOf(err);
    if (wait !== null) return NextResponse.json({ error: `Reconciliation can run once a minute. Try again in ${wait} s.`, retryAfterSeconds: wait }, { status: 429 });
    return NextResponse.json({ error: 'the ledger’s internal port did not answer' }, { status: 502 });
  }
}
