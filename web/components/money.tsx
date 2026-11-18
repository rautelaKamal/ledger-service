import { formatPaise } from '@/lib/money';
import { cn } from '@/lib/utils';

/** An amount in rupees: tabular figures, Indian grouping; money in is green, money out is ink. */
export function Money({ paise, signed = false, className }: { paise: string | bigint; signed?: boolean; className?: string }) {
  const value = typeof paise === 'bigint' ? paise : BigInt(paise);
  return (
    <span className={cn('money whitespace-nowrap', signed && value > 0n && 'text-money-in', className)}>
      {formatPaise(value, signed ? { sign: 'always' } : {})}
    </span>
  );
}
