import { cn } from '@/lib/utils';
import type { PassbookRow } from '@/lib/types';

const LABEL: Record<PassbookRow['status'], string> = { posted: 'Posted', pending: 'Pending', failed: 'Failed' };

/** Status in words AND form (hatched for pending, struck for failed), never colour alone. */
export function StatusChip({ status }: { status: PassbookRow['status'] }) {
  // Like a printed passbook: a posted entry is just an entry. Only the exceptions are marked.
  if (status === 'posted') return <span className="sr-only">Posted</span>;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 text-sm leading-6',
        status === 'pending' && 'hatch border-pending text-pending',
        status === 'failed' && 'border-failed text-failed',
      )}
    >
      {LABEL[status]}
    </span>
  );
}
