// The scripted "last 7 days" means what the live assistant means (agent/tests/test_spending.py).
//   npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastSevenDays, rangeText, type SpendRow } from '../lib/spending.ts';

const THURSDAY = Date.parse('2026-11-26T14:30:00+05:30');
const row = (createdAt: string, amountPaise: string, counterparty: SpendRow['counterparty'], kind = 'transfer', status = 'posted'): SpendRow => ({ createdAt, amountPaise, counterparty, kind, status });
const someone = { isMine: false };
const myOther = { isMine: true };

test('the last 7 days are today and the six India calendar days before it', () => {
  const r = lastSevenDays([], THURSDAY);
  assert.deepEqual([r.from, r.to, r.text], ['2026-11-20', '2026-11-26', '20–26 Nov 2026']);
});

test('only payments to someone else count, within those days', () => {
  const rows = [
    row('2026-11-19T23:59:00+05:30', '-77700', someone), // Thursday before: outside
    row('2026-11-20T00:01:00+05:30', '-11100', someone), // first day, just after midnight IST
    row('2026-11-21T12:00:00+05:30', '-591225', myOther), // Savings -> Current: a move, not spending
    row('2026-11-21T13:00:00+05:30', '500000', null, 'topup'), // a top-up
    row('2026-11-22T23:30:00+05:30', '-50000', someone),
    row('2026-11-24T10:00:00+05:30', '-9999', someone, 'transfer', 'failed'), // never moved
    row('2026-11-26T09:00:00+05:30', '-10000', someone), // today
  ];
  const r = lastSevenDays(rows, THURSDAY);
  assert.equal(r.totalPaise, 71_100n);
  assert.deepEqual(r.payments.map((p) => p.amountPaise), ['-11100', '-50000', '-10000']);
});

test('the range reads like the live answer, across months and years', () => {
  assert.equal(rangeText('2026-11-25', '2026-11-25'), '25 Nov 2026');
  assert.equal(rangeText('2026-11-27', '2026-12-03'), '27 Nov–3 Dec 2026');
  assert.equal(rangeText('2026-12-28', '2027-01-03'), '28 Dec 2026–3 Jan 2027');
});
