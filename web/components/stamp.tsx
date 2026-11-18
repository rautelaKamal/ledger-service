import { cn } from '@/lib/utils';

/**
 * The rubber stamp: the one loud element, used only where the system PROVES
 * something (a verified answer, a replay that moved nothing, 0 problems).
 * `land` plays the stamping motion once; reduced motion skips it.
 */
export function Stamp({ children, land = false, className }: { children: React.ReactNode; land?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block -rotate-6 rounded-sm border-2 border-double border-stamp px-2.5 py-0.5 font-figures text-lg leading-tight font-semibold tracking-wide text-stamp',
        land && 'stamp-land',
        className,
      )}
    >
      {children}
    </span>
  );
}
