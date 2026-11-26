import 'server-only';
import { z } from 'zod';

// Everything the web SERVER needs. None of it is ever sent to the browser:
// internal URLs and client ids stay on this side of the route handlers.
const Env = z.object({
  LEDGER_API_URL: z.url().default('http://127.0.0.1:3000'),
  // The API's internal port (metrics + /system). Not reachable from outside the cluster.
  LEDGER_INTERNAL_URL: z.url().default('http://127.0.0.1:9100'),
  AGENT_URL: z.url().default('http://127.0.0.1:8000'),
  // The mock payment provider: the demo's "approve / decline as the bank" buttons.
  PROVIDER_URL: z.url().default('http://127.0.0.1:4100'),
  // Optional public links shown on the System page.
  GRAFANA_URL: z.url().optional(),
  PROMETHEUS_URL: z.url().optional(),
  // 'fixtures': recorded answers, no model call (development, tests, screenshots).
  // 'agent': ask the real assistant (it spends the Gemini quota).
  ASSISTANT_MODE: z.enum(['fixtures', 'agent']).default('fixtures'),
  // Set ONLY where something really runs reconciliation on a schedule (k8s CronJob),
  // e.g. "every night at 02:00 IST". Unset: the UI makes no claim about a schedule.
  RECONCILE_SCHEDULE: z.string().min(1).optional(),
  // The live assistant's limits (step 7g), in Redis so every web replica shares them.
  // Fail safe: if Redis is unreachable, questions get a labelled scripted answer.
  REDIS_URL: z.string().regex(/^rediss?:\/\//).default('redis://127.0.0.1:6379'),
  REDIS_TIMEOUT_MS: z.coerce.number().int().min(50).max(5_000).default(300),
  ASSISTANT_REDIS_PREFIX: z.string().regex(/^[a-z0-9-]+$/).default('assistant'),
  // Per visitor: BURST questions in a row, then one more every REFILL_SECONDS.
  ASSISTANT_BURST: z.coerce.number().int().min(1).default(5),
  ASSISTANT_REFILL_SECONDS: z.coerce.number().int().min(1).default(180),
  // All visitors together, per Gemini quota day (midnight Pacific). A question costs up
  // to 8 model calls, so 40 is at most 320 calls: well inside the free tier, with room
  // left for an eval run on the same project.
  ASSISTANT_DAILY_CAP: z.coerce.number().int().min(0).default(40),
  // Signs the demo-persona cookie. Required in production.
  SESSION_SECRET: z.string().min(32).default('development-only-session-secret-not-for-production'),
});

export const env = Env.parse(process.env);
