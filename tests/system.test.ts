// Step 7d: the API's internal /system routes, behind the "under the hood" page.
// They run as ledger_reconciler and start actions at most once per cooldown,
// enforced in the database so that every replica sees the same clock.

import type { AddressInfo } from 'node:net';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, type Pool } from '../src/db.js';
import { startMetricsServer } from '../src/metrics-server.js';
import { createSystemService } from '../src/system/service.js';
import { PG, createAccount, fundAccount } from './helpers.js';
import { resetLedger } from './reset.js';

let owner: Pool;
let reconciler: Pool;
let app: Pool;

beforeAll(async () => {
  owner = createPool(process.env.OWNER_DATABASE_URL!, { max: 2 });
  reconciler = createPool(process.env.RECONCILER_DATABASE_URL!, { max: 4 });
  app = createPool(process.env.DATABASE_URL!, { max: 2 });
  await resetLedger(owner);
});

afterAll(async () => {
  await Promise.all([owner.end(), reconciler.end(), app.end()]);
});

beforeEach(async () => {
  await owner.query('TRUNCATE system_actions');
});

describe('status', () => {
  test('1. both outbox lanes, the last reconciliation run, and how many runs in 7 days', async () => {
    const service = createSystemService(reconciler, 60);
    const before = await service.status();
    expect(before.lanes.map((l) => l.lane)).toEqual(['commands', 'events']);
    expect(before.retryAfterSeconds).toEqual({ reconcile: 0, chaos: 0 });

    await owner.query(`INSERT INTO outbox (type, payload) VALUES ('provider.create_payment', '{}'), ('transfer.posted', '{}'), ('transfer.posted', '{}')`);
    const after = await service.status();
    expect(after.lanes.find((l) => l.lane === 'commands')).toMatchObject({ pending: before.lanes[0]!.pending + 1, dead: 0 });
    expect(after.lanes.find((l) => l.lane === 'events')!.pending).toBe(before.lanes[1]!.pending + 2);
    expect(after.lanes[0]!.oldestPendingSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('reconcile now, with a cooldown', () => {
  test('2. runs every check, records the run, and refuses a second start within the cooldown', async () => {
    const acct = await createAccount(app, 'user', 'INR', 'system test');
    await fundAccount(owner, acct, 1_000n);
    const service = createSystemService(reconciler, 60);

    const first = await service.reconcileNow();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.run).toMatchObject({ ok: true, problems: 0 });
    expect((await service.status()).lastReconciliation).toMatchObject({ id: first.run.id, ok: true, problems: 0 });

    const second = await service.reconcileNow();
    expect(second).toEqual({ ok: false, retryAfterSeconds: expect.any(Number) });
    if (second.ok) return;
    expect(second.retryAfterSeconds).toBeGreaterThan(55);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  test('3. the cooldown holds across replicas: five racing starts, exactly one wins', async () => {
    // Five services on separate pools stand in for five API replicas.
    const pools = Array.from({ length: 5 }, () => createPool(process.env.RECONCILER_DATABASE_URL!, { max: 1 }));
    try {
      const claims = await Promise.all(pools.map((p) => createSystemService(p, 60).claim('chaos')));
      expect(claims.filter((c) => c.ok)).toHaveLength(1);
      expect(claims.filter((c) => !c.ok)).toHaveLength(4);
      // Actions have separate cooldowns.
      expect((await createSystemService(reconciler, 60).claim('reconcile')).ok).toBe(true);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  test('4. after the cooldown the action may start again', async () => {
    const service = createSystemService(reconciler, 1);
    expect((await service.claim('chaos')).ok).toBe(true);
    expect((await service.claim('chaos')).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await service.claim('chaos')).ok).toBe(true);
  });

  test('5. the reconciler may record a start but never rewrite or erase one', async () => {
    await createSystemService(reconciler, 60).claim('reconcile');
    await expect(reconciler.query(`UPDATE system_actions SET started_at = now() - interval '1 hour'`)).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    await expect(reconciler.query('DELETE FROM system_actions')).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
    // And the API's own role cannot touch the table at all.
    await expect(app.query('SELECT 1 FROM system_actions')).rejects.toMatchObject({ code: PG.INSUFFICIENT_PRIVILEGE });
  });
});

describe('the internal port', () => {
  async function start(withSystem: boolean): Promise<{ url: string; close: () => Promise<void> }> {
    const server = await startMetricsServer(new Registry(), 0, withSystem ? createSystemService(reconciler, 60) : undefined);
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
  }

  test('6. status, reconcile, chaos; a second start answers 429 with Retry-After and says when', async () => {
    const s = await start(true);
    try {
      expect((await fetch(`${s.url}/system/status`)).status).toBe(200);
      expect((await fetch(`${s.url}/system/reconcile`, { method: 'POST' })).status).toBe(200);
      const again = await fetch(`${s.url}/system/reconcile`, { method: 'POST' });
      expect(again.status).toBe(429);
      const retry = Number(again.headers.get('retry-after'));
      expect(retry).toBeGreaterThan(0);
      expect(await again.json()).toEqual({
        error: { code: 'cooldown', message: `Reconciliation can run once a minute; try again in ${retry} s` },
        retryAfterSeconds: retry,
      });
      expect((await fetch(`${s.url}/system/chaos`, { method: 'POST' })).status).toBe(200);
      expect((await fetch(`${s.url}/system/chaos`, { method: 'POST' })).status).toBe(429);
      expect((await fetch(`${s.url}/system/status`, { method: 'DELETE' })).status).toBe(404);
      expect((await fetch(`${s.url}/metrics`)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  test('7. without RECONCILER_DATABASE_URL the system routes say so (503) and metrics still work', async () => {
    const s = await start(false);
    try {
      const res = await fetch(`${s.url}/system/status`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_configured');
      expect((await fetch(`${s.url}/metrics`)).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});
