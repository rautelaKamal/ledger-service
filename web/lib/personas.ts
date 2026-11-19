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
  /** Light mode only: the cheque paper of their pages (dark mode is one ink blue-black for all). */
  paper: { paper: string; surface: string; rule: string };
}

export const PERSONAS: readonly Persona[] = [
  {
    key: 'meera',
    name: 'Meera Iyer',
    firstName: 'Meera',
    blurb: 'Salaried, keeps a savings and a current account',
    tint: { light: '#2f7fa6', dark: '#63c6f0', uv: 0.11, note: '₹50 blue' },
    paper: { paper: '#eaf1f6', surface: '#f5f9fb', rule: '#c3d3df' },
  },
  {
    key: 'arjun',
    name: 'Arjun Rao',
    firstName: 'Arjun',
    blurb: 'Runs a small shop; card settlements arrive as top-ups',
    tint: { light: '#8a5a35', dark: '#e0a574', uv: 0.12, note: '₹10 brown' },
    paper: { paper: '#f4eeeb', surface: '#fbf8f6', rule: '#dccdc5' },
  },
  {
    key: 'kavya',
    name: 'Kavya Nair',
    firstName: 'Kavya',
    blurb: 'Student; small amounts, one account',
    tint: { light: '#5f7d17', dark: '#c2e05a', uv: 0.08, note: '₹20 green' },
    paper: { paper: '#edf3e7', surface: '#f7faf3', rule: '#cddbc0' },
  },
];

export function personaByKey(key: string | undefined): Persona | undefined {
  return PERSONAS.find((p) => p.key === key);
}

/**
 * The CSS variables for this person's pages (set inline on a [data-persona-scope]
 * container; globals.css turns them into paper, rules, lines and focus colour).
 */
export function tintStyle(p: Persona): Record<string, string> {
  return {
    '--tint': p.tint.light,
    '--tint-uv': p.tint.dark,
    '--uv': String(p.tint.uv),
    '--p-paper': p.paper.paper,
    '--p-surface': p.paper.surface,
    '--p-rule': p.paper.rule,
  };
}
