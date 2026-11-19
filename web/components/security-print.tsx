import type { Persona } from '@/lib/personas';

/** A line of microprint: the person's name, repeated, as an SVG background image (no text in the DOM). */
function microprint(text: string, fill: string): string {
  const line = `${text} `.repeat(4).trim();
  const width = line.length * 2.6;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6"><text x="0" y="5" font-family="sans-serif" font-size="5" fill="${fill}" textLength="${width}" lengthAdjust="spacing">${line}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * The cheque's security print, behind whatever balance it wraps: a flat guilloche
 * in the person's tint (inherited --tint), and optionally a line of microprint
 * with their name. Purely decorative: hidden from assistive technology.
 */
export function SecurityArt({ persona }: { persona?: Persona }) {
  const style = persona
    ? ({ '--microprint-light': microprint(`${persona.name} ledger demo`, persona.tint.light), '--microprint-dark': microprint(`${persona.name} ledger demo`, persona.tint.dark) } as React.CSSProperties)
    : undefined;
  return (
    <div aria-hidden className="security-art" style={style}>
      <span className="lines" />
      {persona ? <span className="microprint" /> : null}
    </div>
  );
}
