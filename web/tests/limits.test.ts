// The live assistant's limits against a real Redis (REDIS_URL, default localhost:6379).
//   npm run test:unit
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { after, describe, test } from 'node:test';
import { createClient } from '@redis/client';
import { quotaDay, redisLimiter, type LimitSettings, type Limiter } from '../lib/server/limits.ts';

const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const raw = createClient({ url: URL });
const opened: Limiter[] = [];

function limiter(settings: Partial<LimitSettings>, url = URL): { limiter: Limiter; prefix: string } {
  const prefix = `test-${randomUUID()}`;
  const l = redisLimiter(url, { burst: 5, refillMs: 180_000, dailyCap: 40, timeoutMs: 500, ...settings }, prefix);
  opened.push(l);
  return { limiter: l, prefix };
}

after(async () => {
  await Promise.all(opened.map((l) => l.close()));
  if (raw.isOpen) {
    for await (const keys of raw.scanIterator({ MATCH: 'test-*', COUNT: 1000 })) if (keys.length) await raw.del(keys);
    await raw.close();
  }
});

describe('per visitor: a token bucket', () => {
  test('BURST questions, then a clear wait; other visitors are not affected', async () => {
    const { limiter: l } = limiter({ burst: 3, refillMs: 60_000 });
    for (let i = 0; i < 3; i++) assert.deepEqual(await l.take('alice'), { ok: true });
    const fourth = await l.take('alice');
    assert.equal(fourth.ok, false);
    assert.equal(!fourth.ok && fourth.reason, 'visitor');
    assert.ok(!fourth.ok && fourth.reason === 'visitor' && fourth.retryAfterMs > 0 && fourth.retryAfterMs <= 60_000);
    assert.deepEqual(await l.take('bob'), { ok: true });
  });

  test('a token comes back after REFILL_MS', async () => {
    const { limiter: l } = limiter({ burst: 1, refillMs: 300 });
    assert.deepEqual(await l.take('carol'), { ok: true });
    assert.equal((await l.take('carol')).ok, false);
    await new Promise((r) => setTimeout(r, 350));
    assert.deepEqual(await l.take('carol'), { ok: true });
  });
});

describe('global: a daily cap across visitors', () => {
  test('DAILY_CAP questions in all, then every visitor is told; refused questions cost no token', async () => {
    const { limiter: l } = limiter({ burst: 2, dailyCap: 3 });
    assert.deepEqual(await l.take('v1'), { ok: true });
    assert.deepEqual(await l.take('v2'), { ok: true });
    assert.deepEqual(await l.take('v3'), { ok: true });
    const over = await l.take('v4');
    assert.equal(!over.ok && over.reason, 'global');
    assert.ok(!over.ok && over.reason === 'global' && over.resetsInMs > 0 && over.resetsInMs <= 86_400_000);
    // v1 still has one of its two tokens: the cap, not v1's bucket, said no.
    const again = await l.take('v1');
    assert.equal(!again.ok && again.reason, 'global');
  });

  test('the counter and the buckets expire on their own', async () => {
    await raw.connect();
    const { limiter: l, prefix } = limiter({ burst: 2, refillMs: 1_000 });
    await l.take('dave');
    const { day, resetsInMs } = quotaDay();
    const ttl = await raw.ttl(`${prefix}:global:${day}`);
    assert.ok(ttl > 0 && ttl <= Math.ceil(resetsInMs / 1000) + 3_600, `global ttl ${ttl}`);
    const pttl = await raw.pTTL(`${prefix}:visitor:dave`);
    assert.ok(pttl > 0 && pttl <= 2 * 1_000 + 60_000, `bucket pttl ${pttl}`);
  });
});

describe('atomic across replicas', () => {
  test('30 questions at once from one visitor: exactly BURST get through', async () => {
    const { limiter: a, prefix } = limiter({ burst: 5 });
    // A second "replica": its own connection, the same keys.
    const b = redisLimiter(URL, { burst: 5, refillMs: 180_000, dailyCap: 40, timeoutMs: 500 }, prefix);
    opened.push(b);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).take('eve')));
    assert.equal(results.filter((r) => r.ok).length, 5);
  });

  test('30 visitors at once against a cap of 7: exactly 7 get through', async () => {
    const { limiter: l } = limiter({ dailyCap: 7 });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => l.take(`crowd-${i}`)));
    assert.equal(results.filter((r) => r.ok).length, 7);
  });
});

describe('fail safe: no Redis means no live answers, never unlimited ones', () => {
  test('nothing listening: unavailable, quickly, every time', async () => {
    const { limiter: l } = limiter({ timeoutMs: 300 }, 'redis://127.0.0.1:1');
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      assert.deepEqual(await l.take('frank'), { ok: false, reason: 'unavailable' });
      assert.ok(Date.now() - started < 1_000);
    }
  });

  test('Redis accepts the connection but never answers: unavailable after TIMEOUT_MS', async () => {
    const silent: Server = createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as { port: number }).port;
    const { limiter: l } = limiter({ timeoutMs: 300 }, `redis://127.0.0.1:${port}`);
    const started = Date.now();
    assert.deepEqual(await l.take('grace'), { ok: false, reason: 'unavailable' });
    assert.ok(Date.now() - started < 1_500);
    await l.close();
    silent.close();
    silent.unref();
  });
});

describe('the quota day is Pacific time (when Gemini resets)', () => {
  test('midnight in Los Angeles is the boundary, not midnight in India', () => {
    assert.deepEqual(quotaDay(new Date('2026-11-26T08:00:00Z')), { day: '2026-11-26', resetsInMs: 86_400_000 });
    assert.deepEqual(quotaDay(new Date('2026-11-26T07:59:59Z')), { day: '2026-11-25', resetsInMs: 1_000 });
    // 18:00 IST on 26 Nov is 04:30 on 26 Nov in California: the same quota day as 00:00 PST.
    assert.equal(quotaDay(new Date('2026-11-26T12:30:00Z')).day, '2026-11-26');
  });
});

