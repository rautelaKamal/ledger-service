// Every date and time is shown in India's time zone, whatever the server's zone is.
const TZ = 'Asia/Kolkata';

const DAY = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const STAMP = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const SHORT = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' });

export const dayLabel = (iso: string): string => DAY.format(new Date(iso));
export const dayKey = (iso: string): string => DAY_KEY.format(new Date(iso));
export const timeLabel = (iso: string): string => TIME.format(new Date(iso));
export const stampLabel = (iso: string): string => `${STAMP.format(new Date(iso))} IST`;
export const shortDay = (yyyyMmDd: string): string => SHORT.format(new Date(`${yyyyMmDd}T12:00:00+05:30`));

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}
