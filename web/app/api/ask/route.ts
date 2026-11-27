import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ask, type OnStep } from '@/lib/server/assistant';
import { currentPersona, currentVisitor, VISITOR_COOKIE, visitorCookieValue } from '@/lib/server/identity';
import { UpstreamError } from '@/lib/server/ledger';
import { NDJSON, type StreamEvent } from '@/lib/ndjson';
import type { Persona } from '@/lib/personas';

const Body = z.object({ question: z.string().trim().min(1).max(500) });

/** What /api/ask answers: the status and body, whether sent as JSON or as the stream's last line. */
async function outcome(persona: Persona, visitor: string, question: string, onStep?: OnStep): Promise<{ status: number; body: unknown }> {
  try {
    const result = await ask(persona, visitor, question, onStep);
    // Over a limit: a clear message, and the question never reached the model.
    return result.kind === 'answer' ? { status: 200, body: result.answer } : { status: 429, body: { error: result.message, limited: true } };
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 429) return { status: 429, body: { error: 'the assistant’s daily limit for this person is reached; try tomorrow', limited: true } };
    return { status: 502, body: { error: 'the assistant is not answering right now; try again in a minute' } };
  }
}

// The web server is the assistant's only caller (the agent's NetworkPolicy allows app=web),
// so this is where the live assistant's limits are enforced (lib/server/limits.ts).
//
// With `accept: application/x-ndjson` the answer streams: one line per step of the live
// assistant as it starts and ends, then {"type": "result", status, body} with exactly what
// the JSON response would have been. Without it, plain JSON as before.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const persona = await currentPersona();
  if (!persona) return NextResponse.json({ error: 'pick a demo person first' }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'ask a question of 1 to 500 characters' }, { status: 400 });
  const visitor = await currentVisitor();
  const question = parsed.data.question;

  let res: NextResponse;
  if (request.headers.get('accept')?.includes(NDJSON)) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: StreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        const { status, body } = await outcome(persona, visitor.id, question, send);
        send({ type: 'result', status, body });
        controller.close();
      },
    });
    // no-transform: compression would hold the lines back until the end.
    res = new NextResponse(stream, { headers: { 'content-type': `${NDJSON}; charset=utf-8`, 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
  } else {
    const { status, body } = await outcome(persona, visitor.id, question);
    res = NextResponse.json(body, { status });
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
