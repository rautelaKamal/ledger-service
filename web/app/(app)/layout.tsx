import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { NavLinks } from '@/components/nav-links';
import { PersonaSwitcher } from '@/components/persona-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { tintStyle } from '@/lib/personas';
import { currentPersona } from '@/lib/server/identity';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const persona = await currentPersona();
  if (!persona) redirect('/');

  return (
    <div style={tintStyle(persona)} className="mx-auto flex min-h-[calc(100dvh-2.25rem)] max-w-6xl">
      <nav aria-label="Main" className="sticky top-0 hidden h-[calc(100dvh-2.25rem)] w-56 shrink-0 flex-col gap-8 border-r border-rule px-4 py-6 md:flex">
        <Link href="/" className="px-3 font-figures text-2xl font-semibold">
          ledger
        </Link>
        <NavLinks variant="rail" />
        <div className="mt-auto flex flex-col gap-4 px-3">
          <PersonaSwitcher current={persona} />
          <ThemeToggle />
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-rule px-4 py-2 md:hidden">
          <Link href="/" className="font-figures text-xl font-semibold">
            ledger
          </Link>
          <div className="flex items-center gap-1">
            <span className="text-sm text-ink-soft">{persona.name}</span>
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="flex-1 px-4 pt-6 pb-28 sm:px-8 md:pb-12">
          {children}
        </main>
      </div>

      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-background/95 backdrop-blur md:hidden">
        <NavLinks variant="tabs" />
      </nav>
    </div>
  );
}
