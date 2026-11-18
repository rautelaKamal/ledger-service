import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { personaByKey, type Persona, type PersonaKey } from '@/lib/personas';
import { env } from './env';

// Who the visitor is "being". The cookie holds only the persona's KEY ("meera"),
// signed so it cannot be edited into someone else's; the X-Client-Id that the
// ledger API and the assistant need is looked up HERE, on the server, and added
// to server-to-server requests. The browser never sees or sends a client id.
//
// This is demo identity, not authentication: anyone may pick any persona.
const CLIENT_IDS: Record<PersonaKey, string> = {
  meera: 'demo-meera',
  arjun: 'demo-arjun',
  kavya: 'demo-kavya',
};
export const CHAOS_CLIENT_ID = 'demo-chaos';

export const COOKIE = 'demo_persona';

function sign(value: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(value).digest('base64url');
}

export function cookieValue(key: PersonaKey): string {
  return `${key}.${sign(key)}`;
}

export function readCookie(raw: string | undefined): Persona | undefined {
  if (!raw) return undefined;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return undefined;
  const key = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(key));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return personaByKey(key);
}

export async function currentPersona(): Promise<Persona | undefined> {
  return readCookie((await cookies()).get(COOKIE)?.value);
}

export function clientIdOf(persona: Persona): string {
  return CLIENT_IDS[persona.key];
}
