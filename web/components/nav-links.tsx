'use client';

import { ArrowLeftRight, Gauge, MessageSquareText, PiggyBank, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export const NAV = [
  { href: '/overview', label: 'Overview', icon: Wallet },
  { href: '/send', label: 'Send', icon: ArrowLeftRight },
  { href: '/topup', label: 'Top up', icon: PiggyBank },
  { href: '/assistant', label: 'Assistant', icon: MessageSquareText },
  { href: '/system', label: 'Under the hood', icon: Gauge },
] as const;

export function NavLinks({ variant }: { variant: 'rail' | 'tabs' }) {
  const pathname = usePathname();
  return (
    <ul className={cn(variant === 'rail' ? 'flex flex-col gap-0.5' : 'grid grid-cols-5')}>
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                variant === 'rail'
                  ? 'flex items-center gap-3 border-l-2 px-3 py-2'
                  : 'flex min-h-14 flex-col items-center justify-center gap-0.5 border-t-2 px-1 text-center text-[0.8125rem] leading-tight',
                active ? 'border-tint-ink font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span>{label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
