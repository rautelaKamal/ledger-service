import { z } from 'zod';

// Validate environment variables once, at startup. If something is missing
// the process fails immediately with a clear message instead of failing
// later on the first database query.
const EnvSchema = z
  .object({
    DATABASE_URL: z.string().startsWith('postgres://'),
    PORT: z.coerce.number().int().positive().default(3000),
    // If set, /metrics is served ONLY on this internal port, not on PORT.
    // Unset (local dev, tests): /metrics stays on PORT, as in step 6a.
    METRICS_PORT: z.coerce.number().int().positive().optional(),
    // Shared secret the provider signs webhooks with. Never hard-code it.
    WEBHOOK_SECRET: z.string().min(16, 'use at least 16 characters'),
    // Step 7d: the internal port's /system routes (status, reconcile now, chaos slot)
    // log in as ledger_reconciler. Unset: those routes answer 503 "not configured".
    RECONCILER_DATABASE_URL: z.string().startsWith('postgres://').optional(),
    // One start per action per this many seconds, across all replicas (system_actions).
    SYSTEM_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  })
  .refine((c) => c.METRICS_PORT !== c.PORT, { message: 'METRICS_PORT must differ from PORT', path: ['METRICS_PORT'] });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
