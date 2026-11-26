import 'server-only';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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

// The visitor: one browser, whichever persona it is being. The live assistant's
// per-visitor limit is keyed on this, not on the persona (many visitors can be Meera).
// A random id, signed like the persona cookie so it cannot be edited into another
// visitor's. Clearing cookies gives a new id and a fresh bucket; the global daily cap
// is what bounds that.
export const VISITOR_COOKIE = 'demo_visitor';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function visitorCookieValue(id: string): string {
  return `${id}.${sign(`visitor:${id}`)}`;
}

export function readVisitor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const dot = raw.lastIndexOf('.');
  const id = raw.slice(0, dot);
  if (dot < 1 || !UUID.test(id)) return undefined;
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(`visitor:${id}`));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : undefined;
}

/** This browser's visitor id; isNew when the caller must set the cookie on its response. */
export async function currentVisitor(): Promise<{ id: string; isNew: boolean }> {
  const id = readVisitor((await cookies()).get(VISITOR_COOKIE)?.value);
  return id ? { id, isNew: false } : { id: randomUUID(), isNew: true };
}
