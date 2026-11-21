import { NextResponse, type NextRequest } from 'next/server';
import { clientIdOf, currentPersona } from '@/lib/server/identity';
import { getTopup, UpstreamError } from '@/lib/server/ledger';

// Polled by the top-up timeline every 1.5 s until the top-up is final.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const persona = await currentPersona();
  if (!persona) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  try {
    return NextResponse.json(await getTopup(clientIdOf(persona), (await params).id));
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return NextResponse.json({ error: 'no such top-up for this person' }, { status: 404 });
    return NextResponse.json({ error: 'the ledger API did not answer' }, { status: 502 });
  }
}
