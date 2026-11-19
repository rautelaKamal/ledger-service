'use client';

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Figures } from '@/components/money';
import { formatPaise } from '@/lib/money';
import { lastShown, moneyMovedRecently, remember } from '@/lib/money-moved';

const DURATION_MS = 700;

// False while React hydrates server HTML, true afterwards (and on client navigation).
const noop = () => () => {};
const useAfterHydration = () => useSyncExternalStore(noop, () => true, () => false);

/**
 * A balance that counts to its new value when the person's OWN action changed it
 * (a send, a posted top-up); otherwise it simply shows the value. Screen readers
 * get the final amount only; reduced motion gets no animation at all. `slot`
 * names the figure across pages ("total:meera", "account:<id>").
 */
export function AnimatedMoney({ paise, slot, label }: { paise: string; slot: string; label?: string }) {
  const target = BigInt(paise);
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  const first = useRef(true);
  // Mounted while hydrating a full page load: the server already painted the final
  // figure, so jumping back to count up would be wrong. Never animate that mount.
  const hydrating = !useAfterHydration();
  const mountedDuringHydration = useRef(hydrating);

  // A layout effect: the starting figure is in place before the browser paints.
  useLayoutEffect(() => {
    // On the first render the starting point is what this slot last showed (maybe
    // on another page); afterwards it is what is on screen now.
    const from = first.current ? (lastShown(slot) ?? target) : current.current;
    const skip = first.current && mountedDuringHydration.current;
    first.current = false;
    remember(slot, target);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (skip || from === target || reduce || !moneyMovedRecently()) {
      current.current = target;
      setShown(target);
      return;
    }
    const diff = Number(target - from);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - (1 - t) ** 3;
      const value = t === 1 ? target : from + BigInt(Math.round(diff * eased));
      current.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, slot]);

  return (
    <span data-paise={target.toString()} data-slot={slot}>
      <span aria-hidden className="money whitespace-nowrap">
        {/* Already hidden from assistive technology: the final amount is read below. */}
        <Figures text={formatPaise(shown)} spoken={false} />
      </span>
      <span className="sr-only">{label ? `${label} ` : ''}{formatPaise(target)}</span>
    </span>
  );
}
