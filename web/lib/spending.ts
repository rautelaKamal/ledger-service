// "What did I spend in the last 7 days?" for the scripted answers, with the same meaning
// the live assistant uses (agent/ledger_agent/dates.py and tools.spending, step 7g):
//   the last 7 days  today and the six days before it, as India calendar days
//   spending         posted transfers to someone else; moving money between your own
//                    accounts is not spending, and neither is a top-up
// and the range written the same way ("20–26 Nov 2026"), so a scripted answer and a live
// one to the same question agree. No app imports, so `node --test` loads it as is.

const EN_DASH = '–';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The India calendar day of an instant, as YYYY-MM-DD. */
export const istDay = (ms: number): string => IST_DAY.format(new Date(ms));

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** '25 Nov 2026', '20–26 Nov 2026', '30 Nov–6 Dec 2026', '28 Dec 2026–3 Jan 2027' (agent: dates.period_text). */
export function rangeText(start: string, end: string): string {
  const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number];
  const [ey, em, ed] = end.split('-').map(Number) as [number, number, number];
  const mon = (m: number) => MONTHS[m - 1];
  if (start === end) return `${sd} ${mon(sm)} ${sy}`;
  if (sy === ey && sm === em) return `${sd}${EN_DASH}${ed} ${mon(em)} ${ey}`;
  if (sy === ey) return `${sd} ${mon(sm)}${EN_DASH}${ed} ${mon(em)} ${ey}`;
  return `${sd} ${mon(sm)} ${sy}${EN_DASH}${ed} ${mon(em)} ${ey}`;
}

export interface SpendRow {
  kind: string;
  status: string;
  createdAt: string;
  amountPaise: string;
  counterparty: { isMine: boolean } | null;
}

export function lastSevenDays<T extends SpendRow>(rows: T[], now: number = Date.now()): { from: string; to: string; text: string; payments: T[]; totalPaise: bigint } {
  const to = istDay(now);
  const from = addDays(to, -6);
  const payments = rows.filter(
    (r) =>
      r.kind === 'transfer' &&
      r.status === 'posted' &&
      BigInt(r.amountPaise) < 0n &&
      r.counterparty !== null &&
      !r.counterparty.isMine &&
      istDay(new Date(r.createdAt).getTime()) >= from &&
      istDay(new Date(r.createdAt).getTime()) <= to,
  );
  const totalPaise = payments.reduce((sum, r) => sum - BigInt(r.amountPaise), 0n);
  return { from, to, text: rangeText(from, to), payments, totalPaise };
}
