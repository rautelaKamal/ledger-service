import { formatPaise } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * Tabular figures, emulated: neither Hind nor Rajdhani has a `tnum` feature (a "1"
 * is 0.33 em, a "0" 0.54 em, and tabular-nums changes nothing), so each digit is
 * padded to a slot as wide as the face's widest digit, and columns of rupees line
 * up digit under digit. The padding is inline margin (globals.css, per digit, face
 * and weight), never an inline block: the amount stays ONE run of text, so copying
 * it, finding it in the page and hearing it all give "₹1,24,560.50", once.
 */
export function Figures({ text }: { text: string }) {
  return (
    <span className="figs">
      {text.split('').map((c, i) =>
        c >= '0' && c <= '9' ? (
          <span key={i} className={`fig fig-${c}`}>
            {c}
          </span>
        ) : (
          c
        ),
      )}
    </span>
  );
}

/** An amount in rupees: Indian grouping, tabular digits; money in is green, money out is ink. */
export function Money({ paise, signed = false, className }: { paise: string | bigint; signed?: boolean; className?: string }) {
  const value = typeof paise === 'bigint' ? paise : BigInt(paise);
  return (
    <span data-paise={value.toString()} className={cn('money whitespace-nowrap', signed && value > 0n && 'text-money-in', className)}>
      <Figures text={formatPaise(value, signed ? { sign: 'always' } : {})} />
    </span>
  );
}
