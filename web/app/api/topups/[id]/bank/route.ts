import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { clientIdOf, currentPersona } from '@/lib/server/identity';
import { getTopup, settlePayment, UpstreamError } from '@/lib/server/ledger';

const Body = z.object({ outcome: z.enum(['succeed', 'fail']) });

// The demo's stand-in for the bank: tells the MOCK provider how the payment ends,
// and the provider then sends its signed webhook to the ledger like a real one.
// Only for the visitor's own top-up (the ledger's 404 rule decides), only once it
// has a payment, and only while it is still pending.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const persona = await currentPersona();
  if (!persona) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'outcome must be succeed or fail' }, { status: 400 });
  try {
    const topup = await getTopup(clientIdOf(persona), (await params).id);
    if (topup.status !== 'pending') return NextResponse.json({ error: `the top-up is already ${topup.status}` }, { status: 409 });
    if (!topup.providerPaymentId) return NextResponse.json({ error: 'the payment has not been created yet; wait for step 2' }, { status: 409 });
    await settlePayment(topup.providerPaymentId, parsed.data.outcome);
    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404 && err.service === 'ledger') return NextResponse.json({ error: 'no such top-up for this person' }, { status: 404 });
    return NextResponse.json({ error: 'the bank (mock provider) did not answer' }, { status: 502 });
  }
}
