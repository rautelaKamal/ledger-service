// The live assistant's two limits, kept in Redis so every web replica shares them:
//
//   per visitor  a token bucket: BURST questions at once, then one more every REFILL_MS
//   global       at most DAILY_CAP live questions per Gemini quota day, across all visitors
//
// Both are checked and taken in ONE Lua script, so Redis applies them atomically: two
// replicas asking at the same moment cannot both take the last token, and a question
// refused by the global cap does not cost the visitor a token.
//
// Fail safe: if Redis cannot be reached, or does not answer within TIMEOUT_MS, the
// decision is 'unavailable'. The caller then answers WITHOUT the model. A broken limiter
// never means an unlimited assistant.
//
// No imports from the app (no '@/', no 'server-only') so `node --test` can load it as is.
import { createClient } from '@redis/client';

export interface LimitSettings {
  /** Questions a visitor may ask in a burst. */
  burst: number;
  /** Milliseconds for one token to come back. */
  refillMs: number;
  /** Live questions per quota day, all visitors together. */
  dailyCap: number;
  /** Give up on Redis after this long; the answer is then 'unavailable'. */
  timeoutMs: number;
}

export type Decision =
  | { ok: true }
  | { ok: false; reason: 'visitor'; retryAfterMs: number }
  | { ok: false; reason: 'global'; resetsInMs: number }
  | { ok: false; reason: 'unavailable' };

export interface Limiter {
  take(visitor: string): Promise<Decision>;
  close(): Promise<void>;
}

// KEYS[1] the visitor's bucket (hash: tokens, ts), KEYS[2] today's global counter.
// ARGV: burst, refill ms, daily cap, counter ttl (s). Time comes from Redis itself
// (TIME), so replicas with skewed clocks still agree.
// Returns {1} when allowed, {0, 1, wait ms} for the visitor limit, {0, 2} for the cap.
const TAKE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local burst = tonumber(ARGV[1])
local per = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
local back = math.floor((now - ts) / per)
if back > 0 then
  tokens = math.min(burst, tokens + back)
  ts = ts + back * per
end
if tokens >= burst then ts = now end
if tokens < 1 then
  return {0, 1, per - (now - ts)}
end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= cap then
  return {0, 2}
end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'ts', ts)
redis.call('PEXPIRE', KEYS[1], burst * per + 60000)
if redis.call('INCR', KEYS[2]) == 1 then
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
end
return {1}
`;

/**
 * Gemini's free quota resets at midnight Pacific time, so the global cap counts per
 * Pacific day: a cap that reset at IST midnight would let twice the cap through within
 * one quota day. Returns the day's key and the time left until it rolls over.
 */
export function quotaDay(now: Date = new Date()): { day: string; resetsInMs: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const sinceMidnight = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return { day: `${parts.year}-${parts.month}-${parts.day}`, resetsInMs: 86_400_000 - sinceMidnight };
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis: no answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function redisLimiter(url: string, settings: LimitSettings, prefix = 'assistant'): Limiter {
  const client = createClient({
    url,
    // Commands sent while disconnected fail at once instead of queueing: a question
    // never waits for Redis to come back, it gets the scripted answer.
    disableOfflineQueue: true,
    socket: { connectTimeout: settings.timeoutMs, reconnectStrategy: (retries: number) => Math.min(250 * 2 ** retries, 5_000) },
  });
  // Without a listener, a lost connection would crash the process.
  client.on('error', () => undefined);
  let connecting: Promise<unknown> | undefined;

  async function take(visitor: string): Promise<Decision> {
    const { day, resetsInMs } = quotaDay();
    try {
      if (!client.isReady) {
        // Not open: (re)start connecting, shared by concurrent questions. Open but not
        // ready: the client is already reconnecting in the background.
        if (!client.isOpen && !connecting) {
          connecting = client
            .connect()
            .catch(() => undefined)
            .finally(() => {
              connecting = undefined;
            });
        }
        if (connecting) await withDeadline(connecting, settings.timeoutMs);
        if (!client.isReady) return { ok: false, reason: 'unavailable' };
      }
      const reply = (await withDeadline(
        client.eval(TAKE, {
          keys: [`${prefix}:visitor:${visitor}`, `${prefix}:global:${day}`],
          arguments: [String(settings.burst), String(settings.refillMs), String(settings.dailyCap), String(Math.ceil(resetsInMs / 1000) + 3_600)],
        }),
        settings.timeoutMs,
      )) as number[];
      if (reply[0] === 1) return { ok: true };
      if (reply[1] === 1) return { ok: false, reason: 'visitor', retryAfterMs: Math.max(0, Number(reply[2])) };
      return { ok: false, reason: 'global', resetsInMs };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  return {
    take,
    // A graceful close waits for replies; a Redis that never answers would hang it, so
    // it gets the same deadline and is then cut off.
    async close() {
      if (!client.isOpen) return;
      try {
        await withDeadline(client.close(), settings.timeoutMs);
      } catch {
        try {
          client.destroy();
        } catch {
          // already closed
        }
      }
    },
  };
}
