import { formatPaise } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * Tabular figures, emulated: neither Hind nor Rajdhani has a `tnum` feature (a "1"
 * is 0.33 em, a "0" 0.54 em, and tabular-nums changes nothing), so each digit sits
 * in a slot as wide as the face's widest digit (--fig-w, set in globals.css) and
 * columns of rupees line up digit under digit. The slotted copy is for the eye;
 * assistive technology reads the plain amount next to it.
 */
export function Figures({ text, spoken = true }: { text: string; spoken?: boolean }) {
  return (
    <>
      <span aria-hidden className="figs">
        {text.split('').map((c, i) =>
          c >= '0' && c <= '9' ? (
            <span key={i} className="fig">
              {c}
            </span>
          ) : (
            c
          ),
        )}
      </span>
      {spoken ? <span className="sr-only">{text}</span> : null}
    </>
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
