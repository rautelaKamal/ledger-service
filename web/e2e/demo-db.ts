import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright drives a real stack that WRITES (transfers, top-ups, chaos runs).
// It may only ever write to the demo/e2e database, never to the dev database the
// eval reads (`ledger`). Locally the stack reads ../.env.e2e.local; in CI the
// workflow sets the same variables.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_FILE = join(ROOT, '.env.e2e.local');
const URL_KEYS = ['DATABASE_URL', 'OWNER_DATABASE_URL', 'WORKER_DATABASE_URL', 'RECONCILER_DATABASE_URL'];

export function assertE2eDatabase(): void {
  const fromFile = existsSync(ENV_FILE)
    ? Object.fromEntries(
        readFileSync(ENV_FILE, 'utf8')
          .split('\n')
          .filter((l) => /^[A-Z_]+=/.test(l))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
    : {};
  for (const key of URL_KEYS) {
    const url = process.env[key] ?? fromFile[key];
    if (!url) throw new Error(`${key} is not set (locally: create ../.env.e2e.local pointing at ledger_e2e)`);
    const db = new URL(url).pathname.slice(1);
    if (db !== 'ledger_e2e') throw new Error(`${key} points at database "${db}": Playwright only ever writes to ledger_e2e`);
  }
}

/** Wipe and re-seed the demo clients only (scripts/demo-reset.ts), so every run starts and ends clean. */
export function resetDemo(): void {
  assertE2eDatabase();
  execFileSync('npx', ['tsx', '--env-file-if-exists=.env.e2e.local', 'scripts/demo-reset.ts'], { cwd: ROOT, stdio: 'inherit' });
}
