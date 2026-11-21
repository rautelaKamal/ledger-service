'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };

/**
 * Light/dark. The new theme spreads as a circle from this button (View Transitions
 * API). Where the API is missing it switches instantly; with reduced motion it
 * always switches instantly.
 */
export function ThemeToggle() {
  const { setTheme } = useTheme();

  function toggle(event: React.MouseEvent<HTMLButtonElement>): void {
    // The theme on screen is the `dark` class on <html> (set before the first paint,
    // also when it only follows the system): the action reads the same truth as the name.
    const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
    const doc = document as ViewTransitionDocument;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || reduce) {
      setTheme(next);
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = doc.startViewTransition(() => {
      // The DOM must be in the new theme when this callback returns: apply it now.
      flushSync(() => setTheme(next));
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.classList.toggle('light', next === 'light');
      document.documentElement.style.colorScheme = next;
    });
    void transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 450, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    });
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle}>
      <Sun className="size-4 dark:hidden" aria-hidden />
      <Moon className="hidden size-4 dark:block" aria-hidden />
      {/* The name follows the theme actually shown, from the first paint: the same
          `dark` class that picks the icon picks the words. (A name computed in React
          was the server's guess, and hydration keeps a mismatched attribute.) */}
      <span className="sr-only dark:hidden">Switch to dark theme</span>
      <span className="sr-only hidden dark:inline">Switch to light theme</span>
    </Button>
  );
}
