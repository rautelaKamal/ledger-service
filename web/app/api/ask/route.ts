import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ask } from '@/lib/server/assistant';
import { currentPersona } from '@/lib/server/identity';
import { UpstreamError } from '@/lib/server/ledger';

const Body = z.object({ question: z.string().trim().min(1).max(500) });

// The web server is the assistant's only caller (the agent's NetworkPolicy allows app=web).
export async function POST(request: NextRequest): Promise<NextResponse> {
  const persona = await currentPersona();
  if (!persona) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'ask a question of 1 to 500 characters' }, { status: 400 });
  try {
    return NextResponse.json(await ask(persona, parsed.data.question));
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 429) return NextResponse.json({ error: 'the assistant’s daily limit for this person is reached; try tomorrow' }, { status: 429 });
    return NextResponse.json({ error: 'the assistant is not answering right now; try again in a minute' }, { status: 502 });
  }
}
