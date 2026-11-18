import { NextResponse, type NextRequest } from 'next/server';
import { clientIdOf, currentPersona } from '@/lib/server/identity';
import { getPassbook, UpstreamError } from '@/lib/server/ledger';

// The browser asks for older passbook rows here; the web server adds X-Client-Id.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const persona = await currentPersona();
  if (!persona) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  const account = request.nextUrl.searchParams.get('account') ?? '';
  const cursor = request.nextUrl.searchParams.get('cursor') ?? undefined;
  try {
    return NextResponse.json(await getPassbook(clientIdOf(persona), account, cursor));
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502;
    return NextResponse.json({ error: 'the ledger did not return the passbook' }, { status: status === 404 ? 404 : 502 });
  }
}
