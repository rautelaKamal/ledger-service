import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { clientIdOf, currentPersona } from '@/lib/server/identity';
import { postTopup } from '@/lib/server/ledger';

const Body = z.object({
  accountId: z.uuid(),
  amountPaise: z.string().regex(/^[1-9][0-9]{0,15}$/),
  idempotencyKey: z.string().min(8).max(255),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const persona = await currentPersona();
  if (!persona) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'the form is not complete' }, { status: 400 });
  const { idempotencyKey, ...body } = parsed.data;
  try {
    const exchange = await postTopup(clientIdOf(persona), idempotencyKey, body);
    const topupId = (exchange.response.body as { topupId?: string } | null)?.topupId ?? null;
    return NextResponse.json({ exchange, topupId });
  } catch {
    return NextResponse.json({ error: 'the ledger API did not answer' }, { status: 502 });
  }
}
