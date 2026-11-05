import { existsSync } from 'node:fs';

// Vitest only exposes VITE_* variables from env files, so we load .env.test
// ourselves with Node's built-in loader (no dotenv). In CI there is no
// .env.test: the workflow sets DATABASE_URL / OWNER_DATABASE_URL directly.
export function loadTestEnv(): void {
  if (existsSync('.env.test')) {
    process.loadEnvFile('.env.test');
  }
}

loadTestEnv();
