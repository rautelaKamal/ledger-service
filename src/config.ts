import { z } from 'zod';

// Validate environment variables once, at startup. If something is missing
// the process fails immediately with a clear message instead of failing
// later on the first database query.
const EnvSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgres://'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Shared secret the provider signs webhooks with. Never hard-code it.
  WEBHOOK_SECRET: z.string().min(16, 'use at least 16 characters'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
