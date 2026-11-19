'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatPaise, parseRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

/** The selects next to an amount field: the same height and box as the field. */
export const fieldSelectClass = 'h-10 w-full rounded-md border border-input bg-surface px-3';

/**
 * What an amount field holds: the paise (or null), and the field's own problem, if any.
 * The form's submit button waits for `ok`; the problem is said once, under the field.
 */
export function readAmount(value: string, max: bigint, what: 'transfer' | 'top-up'): { paise: bigint | null; problem: string | null; ok: boolean } {
  if (value.trim() === '') return { paise: null, problem: null, ok: false };
  const paise = parseRupees(value);
  if (!paise) return { paise: null, problem: 'Enter rupees, for example 1,200.00', ok: false };
  if (paise > max) return { paise, problem: `Over the ${formatPaise(max)} limit for one ${what}`, ok: false };
  return { paise, problem: null, ok: true };
}

/**
 * The amount field of Send and Top up: label, field, and one line under it that is
 * always there (so typing never moves what is below). The line says the limit while
 * the field is empty, the amount as it will be sent, or the field's problem.
 */
export function AmountField({
  id,
  value,
  onChange,
  max,
  what,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  max: bigint;
  what: 'transfer' | 'top-up';
  placeholder: string;
  disabled?: boolean;
}) {
  const { paise, problem } = readAmount(value, max, what);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Amount in rupees</Label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="money h-10"
        aria-invalid={problem !== null}
        aria-describedby={`${id}-help`}
      />
      <span id={`${id}-help`} className={cn('min-h-5 text-sm', problem ? 'text-failed' : 'text-ink-soft')} aria-live="polite">
        {value.trim() === '' ? `At most ${formatPaise(max)} per ${what}` : (problem ?? formatPaise(paise!))}
      </span>
    </div>
  );
}
