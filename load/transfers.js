// k6 load test for the ledger (runs in the grafana/k6 container; see docker-compose.full.yml).
//
//   docker compose -f docker-compose.full.yml run --rm -T seed > load/out/accounts.json
//   docker compose -f docker-compose.full.yml run --rm k6
//
// Scenario "transfers": VUS virtual users, each in a loop, send a transfer
// between two random seeded accounts with a UNIQUE Idempotency-Key. About 10%
// of iterations then immediately resend the SAME request with the SAME key and
// check that the stored response comes back (Idempotent-Replayed: true).
//
// Scenario "topups": one top-up per second through the real flow (POST /topups
// -> worker asks the provider -> provider confirms -> signed webhook posts it),
// so the webhook and outbox panels have live data during the run.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const accounts = JSON.parse(open('./out/accounts.json')).accounts;
const API = __ENV.API_URL || 'http://api:3000';
const PROVIDER = __ENV.PROVIDER_URL || 'http://mock-provider:4100';
const DURATION = __ENV.DURATION || '2m';

const replays = new Counter('ledger_replays_checked');
const replayMismatches = new Counter('ledger_replay_mismatches');
const insufficientFunds = new Counter('ledger_insufficient_funds');
const topupsConfirmed = new Counter('ledger_topups_confirmed');

export const options = {
  scenarios: {
    transfers: { executor: 'constant-vus', exec: 'transfer', vus: Number(__ENV.VUS || 20), duration: DURATION },
    topups: { executor: 'constant-arrival-rate', exec: 'topup', rate: 1, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 4, maxVUs: 8 },
  },
  thresholds: {
    'http_req_failed{scenario:transfers}': ['rate<0.01'],
    'http_req_duration{scenario:transfers}': ['p(95)<500'],
    ledger_replay_mismatches: ['count==0'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// 201 created, 202 accepted, 422 insufficient funds: all correct answers.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 422));

const rand = (n) => Math.floor(Math.random() * n);
const id = () => `${__VU}-${__ITER}-${Date.now()}-${rand(1e9)}`;

export function transfer() {
  const from = accounts[rand(accounts.length)];
  let to = accounts[rand(accounts.length)];
  while (to === from) to = accounts[rand(accounts.length)];
  const body = JSON.stringify({ fromAccountId: from, toAccountId: to, amountPaise: String(1 + rand(500)) });
  const params = {
    headers: { 'content-type': 'application/json', 'x-client-id': 'k6', 'idempotency-key': `k6-${id()}`, 'x-request-id': `k6-${id()}` },
    tags: { name: 'POST /transfers' },
  };

  const res = http.post(`${API}/transfers`, body, params);
  check(res, { 'transfer: 201 or 422': (r) => r.status === 201 || r.status === 422 });
  if (res.status === 422) insufficientFunds.add(1);

  // A client that never saw the response retries with the same key.
  if (Math.random() < 0.1) {
    const retry = http.post(`${API}/transfers`, body, { ...params, tags: { name: 'POST /transfers (retry)' } });
    replays.add(1);
    const same = retry.status === res.status && retry.body === res.body && retry.headers['Idempotent-Replayed'] === 'true';
    if (!same) replayMismatches.add(1);
    check(retry, { 'retry: same stored response, Idempotent-Replayed': () => same });
  }
}

export function topup() {
  const account = accounts[rand(accounts.length)];
  const res = http.post(`${API}/topups`, JSON.stringify({ accountId: account, amountPaise: String(100 + rand(10000)) }), {
    headers: { 'content-type': 'application/json', 'x-client-id': 'k6', 'idempotency-key': `k6-topup-${id()}`, 'x-request-id': `k6-topup-${id()}` },
    tags: { name: 'POST /topups' },
  });
  if (!check(res, { 'topup: 202': (r) => r.status === 202 })) return;
  const topupId = res.json('topupId');

  // The worker asks the provider for the payment within a second or so.
  for (let i = 0; i < 20; i++) {
    const found = http.get(`${PROVIDER}/payments?reference=${topupId}`, { tags: { name: 'GET provider payment' } });
    const payments = found.status === 200 ? found.json() : [];
    if (payments.length > 0) {
      const ok = http.post(`${PROVIDER}/payments/${payments[0].id}/succeed`, '{}', {
        headers: { 'content-type': 'application/json' },
        tags: { name: 'POST provider succeed' },
      });
      if (check(ok, { 'topup: provider confirms': (r) => r.status === 202 })) topupsConfirmed.add(1);
      return;
    }
    sleep(0.25);
  }
  check(null, { 'topup: provider confirms': () => false });
}
