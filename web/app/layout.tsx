import type { Metadata, Viewport } from 'next';
import { Hind, Rajdhani } from 'next/font/google';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

// Hind (Indian Type Foundry) for all text; Rajdhani's squared digits for the balance.
// Both carry the ₹ sign; latin-ext is the subset that contains it.
const hind = Hind({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--font-hind', display: 'swap' });
const rajdhani = Rajdhani({ subsets: ['latin', 'latin-ext'], weight: ['600'], variable: '--font-rajdhani', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'ledger-service demo', template: '%s | ledger-service demo' },
  description: 'A double-entry ledger you can poke at. Fictional people, no real money.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1d21' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" className={`${hind.variable} ${rajdhani.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <TooltipProvider>
            <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-surface focus:px-3 focus:py-2">
              Skip to content
            </a>
            <p className="border-b border-rule bg-surface px-4 py-1.5 text-center text-sm text-ink-soft">
              Demo: fictional people, no real money.
            </p>
            {children}
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
