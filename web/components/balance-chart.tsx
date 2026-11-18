'use client';

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { shortDay } from '@/lib/dates';
import { formatPaise } from '@/lib/money';
import type { BalanceDay } from '@/lib/types';

const config = { balance: { label: 'Balance', color: 'var(--ink)' } } satisfies ChartConfig;

// Axis ticks in whole rupees with Indian grouping (₹1,20,000), never "1.2L".
const tick = (rupees: number) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(rupees)}`;

export function BalanceChart({ days }: { days: BalanceDay[] }) {
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
      <ChartContainer config={config} className="aspect-auto h-48 w-full sm:h-56" aria-hidden>
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
