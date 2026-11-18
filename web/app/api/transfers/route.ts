import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { clientIdOf, currentPersona } from '@/lib/server/identity';
import { getAccounts, postTransfer } from '@/lib/server/ledger';

const Body = z.object({
  fromAccountId: z.uuid(),
  toAccountId: z.uuid(),
  amountPaise: z.string().regex(/^[1-9][0-9]{0,15}$/),
  note: z.string().max(140).optional(),
  idempotencyKey: z.string().min(8).max(255),
});

// One transfer, exactly as the ledger API sees it. The web server adds X-Client-Id;
// the browser chose the Idempotency-Key and sends it again to prove the replay.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const persona = await currentPersona();
  if (!persona) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'the form is not complete' }, { status: 400 });
  const { idempotencyKey, ...body } = parsed.data;
  const clientId = clientIdOf(persona);

  const balanceOf = async () => (await getAccounts(clientId)).find((a) => a.id === body.fromAccountId)?.balancePaise ?? null;
  try {
    const before = await balanceOf();
    const exchange = await postTransfer(clientId, idempotencyKey, body);
    const after = await balanceOf();
    return NextResponse.json({ exchange, fromBalanceBefore: before, fromBalanceAfter: after });
  } catch {
    return NextResponse.json({ error: 'the ledger API did not answer' }, { status: 502 });
  }
}
