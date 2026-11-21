'use client';

import { useSyncExternalStore } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { shortDay } from '@/lib/dates';
import { formatPaise } from '@/lib/money';
import type { BalanceDay } from '@/lib/types';

// The line in the person's tint (their pages' quiet colour; 3.9:1 or more on their paper).
const config = { balance: { label: 'Balance', color: 'var(--tint-ink)' } } satisfies ChartConfig;

// Axis ticks in whole rupees with Indian grouping (₹1,20,000), never "1.2L".
const tick = (rupees: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(rupees)}`;

// True only in the browser after hydration: the server (and the first paint) gets the placeholder.
const noop = () => () => {};
const useHydrated = () => useSyncExternalStore(noop, () => true, () => false);

/** Same box as the chart, with its ruled lines: nothing jumps when the chart arrives. */
function ChartPlaceholder() {
  return (
    <div className="flex h-48 w-full flex-col justify-between pt-2 pb-8 pl-[92px] sm:h-56" role="status">
      <span className="sr-only">Drawing the chart</span>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className="block h-px w-full bg-rule" aria-hidden />
      ))}
    </div>
  );
}

export function BalanceChart({ days }: { days: BalanceDay[] }) {
  const hydrated = useHydrated();
  const data = days.map((d) => ({ day: d.day, paise: d.balancePaise, balance: Number(BigInt(d.balancePaise) / 100n) }));
  const first = data[0];
  const last = data.at(-1);
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-ink-soft">
        Balance at the end of each day, last {days.length} days
        {first && last ? (
          <span className="sr-only">
            {' '}
            from {formatPaise(first.paise)} on {shortDay(first.day)} to {formatPaise(last.paise)} on {shortDay(last.day)}
          </span>
        ) : null}
      </figcaption>
      {!hydrated ? <ChartPlaceholder /> : null}
      <ChartContainer config={config} className={hydrated ? 'aspect-auto h-48 w-full sm:h-56' : 'hidden'} aria-hidden>
        {/* Decorative for assistive tech (the caption says the start and end; the passbook has every amount), so not focusable either. */}
        <LineChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 0 }} accessibilityLayer={false}>
          <CartesianGrid vertical={false} stroke="var(--rule)" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={36} tickFormatter={shortDay} />
          <YAxis width={84} tickLine={false} axisLine={false} tickFormatter={tick} domain={['auto', 'auto']} />
          <ChartTooltip
            cursor={{ stroke: 'var(--rule)' }}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
              return p ? (
                <div className="rounded-md border border-rule bg-surface px-2.5 py-1.5 text-sm shadow-sm">
                  <div className="text-ink-soft">{shortDay(p.day)}</div>
                  <div className="money font-medium">{formatPaise(p.paise)}</div>
                </div>
              ) : null;
            }}
          />
          <Line type="stepAfter" dataKey="balance" stroke="var(--color-balance)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
    </figure>
  );
}
