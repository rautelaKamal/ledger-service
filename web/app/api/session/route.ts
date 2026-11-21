import { NextResponse, type NextRequest } from 'next/server';
import { personaByKey } from '@/lib/personas';
import { COOKIE, cookieValue } from '@/lib/server/identity';

// Pick (or drop) the demo persona. Works without JavaScript, two ways:
//   GET  /api/session?persona=meera   a plain link: the landing page's person slips
//   POST /api/session (form)          the person switcher inside the app
// A link is the most dependable navigation a browser has, so the landing page uses
// one. Choosing a persona from a GET is harmless here: it is not a login (anyone may
// be anyone in this demo) and it changes nothing in the ledger.
// The cookie holds the persona's key, signed; never a client id.
//
// The redirect is RELATIVE ("Location: /overview"): behind a proxy or in a container
// the server does not know the host the browser used, and an absolute URL built from
// its own idea of the host would send the browser (and the cookie) somewhere else.
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

function choose(request: NextRequest, key: string, next: string): NextResponse {
  const persona = personaByKey(key);
  if (!persona) {
    const res = seeOther('/');
    res.cookies.delete(COOKIE);
    return res;
  }
  const res = seeOther(next.startsWith('/') && !next.startsWith('//') ? next : '/overview');
  res.cookies.set(COOKIE, cookieValue(persona.key), {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.headers.get('x-forwarded-proto') === 'https' || request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = request.nextUrl.searchParams;
  return choose(request, q.get('persona') ?? '', q.get('next') ?? '/overview');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  return choose(request, String(form.get('persona') ?? ''), String(form.get('next') ?? '/overview'));
}
