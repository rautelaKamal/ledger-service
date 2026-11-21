// "The person just moved money": set by the Send and Top up flows when their own
// action changed a balance. Balances count to their new value only when this is
// fresh, so a figure that changed for any other reason simply appears.
const KEY = 'ledger:money-moved';
const FRESH_MS = 60_000;

export function markMoneyMoved(): void {
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* private mode: no animation, nothing else lost */
  }
}

export function moneyMovedRecently(): boolean {
  try {
    return Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < FRESH_MS;
  } catch {
    return false;
  }
}

export function lastShown(slot: string): bigint | null {
  try {
    const v = sessionStorage.getItem(`ledger:shown:${slot}`);
    return v === null ? null : BigInt(v);
  } catch {
    return null;
  }
}

export function remember(slot: string, paise: bigint): void {
  try {
    sessionStorage.setItem(`ledger:shown:${slot}`, paise.toString());
  } catch {
    /* ignore */
  }
}
