// Money is carried as a string of paise (bigint-safe) and shown the Indian way:
// ₹1,24,560.50. Never rounded, never "1.2 lakh".
const GROUPING = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function formatPaise(paise: string | bigint, opts: { sign?: 'always' | 'negative' } = {}): string {
  const value = typeof paise === 'bigint' ? paise : BigInt(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const text = `₹${GROUPING.format(abs / 100n)}.${(abs % 100n).toString().padStart(2, '0')}`;
  if (negative) return `−${text}`; // a real minus sign, not a hyphen
  return opts.sign === 'always' && value > 0n ? `+${text}` : text;
}

/** "1,200.50" from a user's input, or null. At most two decimals, no grouping required. */
export function parseRupees(input: string): bigint | null {
  const clean = input.replace(/[₹,\s]/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  const paise = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  return paise > 0n ? paise : null;
}

export function sumPaise(values: Array<string | bigint>): bigint {
  return values.reduce<bigint>((acc, v) => acc + (typeof v === 'bigint' ? v : BigInt(v)), 0n);
}
