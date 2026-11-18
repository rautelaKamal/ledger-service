import { NextResponse, type NextRequest } from 'next/server';
import { personaByKey } from '@/lib/personas';
import { COOKIE, cookieValue } from '@/lib/server/identity';

// Pick (or drop) the demo persona. A plain form POST, so it works without JavaScript.
// The cookie holds the persona's key, signed; never a client id.
//
// The redirect is RELATIVE ("Location: /overview"): behind a proxy or in a container
// the server does not know the host the browser used, and an absolute URL built from
// its own idea of the host would send the browser (and the cookie) somewhere else.
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const persona = personaByKey(String(form.get('persona') ?? ''));
  const next = String(form.get('next') ?? '/overview');
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
