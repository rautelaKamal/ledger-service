import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ask } from '@/lib/server/assistant';
import { currentPersona, currentVisitor, VISITOR_COOKIE, visitorCookieValue } from '@/lib/server/identity';
import { UpstreamError } from '@/lib/server/ledger';

const Body = z.object({ question: z.string().trim().min(1).max(500) });

// The web server is the assistant's only caller (the agent's NetworkPolicy allows app=web),
// so this is where the live assistant's limits are enforced (lib/server/limits.ts).
export async function POST(request: NextRequest): Promise<NextResponse> {
  const persona = await currentPersona();
  if (!persona) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'ask a question of 1 to 500 characters' }, { status: 400 });
  const visitor = await currentVisitor();
  let res: NextResponse;
  try {
    const outcome = await ask(persona, visitor.id, parsed.data.question);
    // Over a limit: a clear message, and the question never reached the model.
    res = outcome.kind === 'answer' ? NextResponse.json(outcome.answer) : NextResponse.json({ error: outcome.message, limited: true }, { status: 429 });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 429) res = NextResponse.json({ error: 'the assistant’s daily limit for this person is reached; try tomorrow', limited: true }, { status: 429 });
    else res = NextResponse.json({ error: 'the assistant is not answering right now; try again in a minute' }, { status: 502 });
  }
  if (visitor.isNew) {
    res.cookies.set(VISITOR_COOKIE, visitorCookieValue(visitor.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.headers.get('x-forwarded-proto') === 'https' || request.nextUrl.protocol === 'https:',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
  }
  return res;
}
