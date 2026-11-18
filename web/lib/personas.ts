// The fictional people a visitor can "be". Safe for the browser: no client ids here
// (those live in lib/server/identity.ts and never leave the server).
export type PersonaKey = 'meera' | 'arjun' | 'kavya';

export interface Persona {
  key: PersonaKey;
  name: string;
  firstName: string;
  blurb: string;
}

export const PERSONAS: readonly Persona[] = [
  { key: 'meera', name: 'Meera Iyer', firstName: 'Meera', blurb: 'Salaried, keeps a savings and a current account' },
  { key: 'arjun', name: 'Arjun Rao', firstName: 'Arjun', blurb: 'Runs a small shop; card settlements arrive as top-ups' },
  { key: 'kavya', name: 'Kavya Nair', firstName: 'Kavya', blurb: 'Student; small amounts, one account' },
];

export function personaByKey(key: string | undefined): Persona | undefined {
  return PERSONAS.find((p) => p.key === key);
}
