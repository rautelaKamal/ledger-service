import { cn } from '@/lib/utils';
import type { PassbookRow } from '@/lib/types';

const LABEL: Record<PassbookRow['status'], string> = { posted: 'Posted', pending: 'Pending', failed: 'Failed' };

/** Status in words AND form (hatched for pending, struck for failed), never colour alone. */
export function StatusChip({ status }: { status: PassbookRow['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 text-sm leading-6',
        status === 'posted' && 'border-rule text-ink-soft',
        status === 'pending' && 'hatch border-pending text-pending',
        status === 'failed' && 'border-failed text-failed',
      )}
    >
      {LABEL[status]}
    </span>
  );
}
