'use client';

import { createColumnHelper, flexRender, tableFeatures, useTable } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { Money } from '@/components/money';
import { StatusChip } from '@/components/status-chip';
import { Button } from '@/components/ui/button';
import { dayKey, dayLabel, timeLabel } from '@/lib/dates';
import type { PassbookPage, PassbookRow } from '@/lib/types';
import { cn } from '@/lib/utils';

const features = tableFeatures({ columnMeta: {} as { align?: 'right'; className?: string } });
const column = createColumnHelper<typeof features, PassbookRow>();

function particulars(r: PassbookRow): string {
  if (r.kind === 'topup') return r.status === 'failed' ? 'Top-up, failed' : r.status === 'pending' ? 'Top-up, waiting for the bank' : 'Top-up';
  if (!r.counterparty) return 'Transfer';
  const out = BigInt(r.amountPaise) < 0n;
  const who = r.counterparty.isMine ? `your ${r.counterparty.name.split(', ').at(-1)}` : r.counterparty.name;
  return out ? `To ${who}` : `From ${who}`;
}

const columns = [
  column.display({
    id: 'particulars',
    header: 'Particulars',
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex flex-col">
          <span className={cn(r.status === 'failed' && 'text-ink-soft')}>{particulars(r)}</span>
          <span className="text-sm text-ink-soft">
            {timeLabel(r.createdAt)}
            {r.note ? `, ${r.note}` : ''}
          </span>
        </div>
      );
    },
  }),
  column.display({
    id: 'status',
    header: 'Status',
    meta: { className: 'hidden sm:table-cell' },
    cell: ({ row }) => <StatusChip status={row.original.status} />,
  }),
  column.display({
    id: 'withdrawal',
    header: 'Withdrawal',
    meta: { align: 'right' },
    cell: ({ row }) => {
      const v = BigInt(row.original.amountPaise);
      return v < 0n ? <Money paise={-v} className={cn(row.original.status === 'failed' && 'line-through')} /> : null;
    },
  }),
  column.display({
    id: 'deposit',
    header: 'Deposit',
    meta: { align: 'right' },
    cell: ({ row }) => {
      const r = row.original;
      const v = BigInt(r.amountPaise);
      if (v <= 0n) return null;
      return <Money paise={v} className={cn(r.status === 'posted' && 'text-money-in', r.status === 'failed' && 'text-ink-soft line-through', r.status === 'pending' && 'hatch px-1 text-pending')} />;
    },
  }),
  column.display({
    id: 'balance',
    header: 'Balance',
    meta: { align: 'right', className: 'hidden sm:table-cell' },
    cell: ({ row }) => (row.original.balanceAfterPaise ? <Money paise={row.original.balanceAfterPaise} /> : <span className="text-sm text-ink-soft">not in balance</span>),
  }),
];

export function Passbook({ accountId, initial }: { accountId: string; initial: PassbookPage }) {
  const [rows, setRows] = useState(initial.transactions);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const table = useTable({ features, columns, data: rows, getRowId: (r) => r.id });

  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; rows: ReturnType<typeof table.getRowModel>['rows'] }> = [];
    for (const row of table.getRowModel().rows) {
      const key = dayKey(row.original.createdAt);
      const last = out.at(-1);
      if (last?.key === key) last.rows.push(row);
      else out.push({ key, label: dayLabel(row.original.createdAt), rows: [row] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  async function loadOlder(): Promise<void> {
    if (!cursor) return;
    setState('loading');
    try {
      const res = await fetch(`/api/passbook?account=${encodeURIComponent(accountId)}&cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as PassbookPage;
      setRows((r) => [...r, ...page.transactions]);
      setCursor(page.nextCursor);
      setState('idle');
    } catch {
      setState('error');
    }
  }

  if (rows.length === 0) {
    return <p className="border-t border-rule py-6 text-ink-soft">No entries yet. Money you send or add appears here, newest first.</p>;
  }

  return (
    <div>
      <table className="w-full border-collapse">
        <caption className="sr-only">Passbook, newest entries first</caption>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b-2 border-ink text-left text-sm text-ink-soft">
              {hg.headers.map((h) => (
                <th key={h.id} scope="col" className={cn('py-2 pr-3 font-medium last:pr-0', h.column.columnDef.meta?.align === 'right' && 'text-right', h.column.columnDef.meta?.className)}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        {groups.map((g) => (
          <tbody key={g.key}>
            <tr>
              <th colSpan={columns.length} scope="rowgroup" className="pt-5 pb-1 text-left font-medium">
                {g.label}
              </th>
            </tr>
            {g.rows.map((row) => (
              <tr key={row.id} className="border-b border-rule align-top">
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className={cn('py-2.5 pr-3 last:pr-0', cell.column.columnDef.meta?.align === 'right' && 'text-right', cell.column.columnDef.meta?.className)}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <div className="mt-4 flex items-center gap-3">
        {cursor ? (
          <Button variant="outline" onClick={loadOlder} disabled={state === 'loading'}>
            {state === 'loading' ? 'Loading older entries…' : 'Show older entries'}
          </Button>
        ) : (
          <p className="text-sm text-ink-soft">That is the first entry on this account.</p>
        )}
        {state === 'error' ? <p role="alert" className="text-sm text-failed">Older entries did not load. Try again.</p> : null}
      </div>
    </div>
  );
}
