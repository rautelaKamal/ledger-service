// The fictional people a visitor can "be". Safe for the browser: no client ids here
// (those live in lib/server/identity.ts and never leave the server).
export type PersonaKey = 'meera' | 'arjun' | 'kavya';

export interface Persona {
  key: PersonaKey;
  name: string;
  firstName: string;
  blurb: string;
  /**
   * The tint of their security print, after a banknote's colour. Decoration only,
   * never text. `uv`: how strongly it shows in dark mode (bright tints need less).
   */
  tint: { light: string; dark: string; uv: number; note: string };
}

export const PERSONAS: readonly Persona[] = [
  {
    key: 'meera',
    name: 'Meera Iyer',
    firstName: 'Meera',
    blurb: 'Salaried, keeps a savings and a current account',
    tint: { light: '#2f7fa6', dark: '#63c6f0', uv: 0.11, note: '₹50 blue' },
  },
  {
    key: 'arjun',
    name: 'Arjun Rao',
    firstName: 'Arjun',
    blurb: 'Runs a small shop; card settlements arrive as top-ups',
    tint: { light: '#8a5a35', dark: '#e0a574', uv: 0.12, note: '₹10 brown' },
  },
  {
    key: 'kavya',
    name: 'Kavya Nair',
    firstName: 'Kavya',
    blurb: 'Student; small amounts, one account',
    tint: { light: '#6b8a1e', dark: '#c2e05a', uv: 0.08, note: '₹20 green' },
  },
];

export function personaByKey(key: string | undefined): Persona | undefined {
  return PERSONAS.find((p) => p.key === key);
}

/** The CSS variables that tint a security print for this person (set inline on a container). */
export function tintStyle(p: Persona): Record<string, string> {
  return { '--tint': p.tint.light, '--tint-uv': p.tint.dark, '--uv': String(p.tint.uv) };
}
