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
  // Signs the demo-persona cookie. Required in production.
  SESSION_SECRET: z.string().min(32).default('development-only-session-secret-not-for-production'),
});

export const env = Env.parse(process.env);
