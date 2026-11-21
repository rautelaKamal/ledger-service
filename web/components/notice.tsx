import { cn } from '@/lib/utils';

/** Errors say what happened and what to do; no apologies, no vagueness. */
export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'error'; title: string; children?: React.ReactNode; className?: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('border-l-2 py-1 pl-3', tone === 'error' ? 'border-failed' : 'border-rule', className)}>
      <p className={cn('font-medium', tone === 'error' && 'text-failed')}>{title}</p>
      {children ? <div className="text-ink-soft">{children}</div> : null}
    </div>
  );
}
