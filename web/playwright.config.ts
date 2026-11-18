import { defineConfig, devices } from '@playwright/test';

// The whole stack, started by Playwright: ledger API (+ its internal port), outbox
// worker, mock payment provider, and this web app (built first: `npm run build`).
// Locally the services read ../.env.e2e.local (a separate ledger_e2e database);
// in CI the workflow provides the same variables. Ports avoid the usual dev ones.
const API = 'http://127.0.0.1:3100';
const INTERNAL = 'http://127.0.0.1:9200';
const PROVIDER = 'http://127.0.0.1:4200';
const WEB = 'http://127.0.0.1:3200';
const ci = Boolean(process.env.CI);
const envFile = '--env-file-if-exists=.env.e2e.local';

const devicesMatrix = [
  { name: 'desktop', use: { viewport: { width: 1366, height: 900 } } },
  { name: 'phone', use: { ...devices['Pixel 7'] } },
] as const;
const themes = ['light', 'dark'] as const;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // one shared ledger: flows run in order
  retries: 0,
  forbidOnly: ci,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: WEB, trace: 'retain-on-failure', locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  projects: [
    { name: 'flows', testMatch: /flows\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    ...devicesMatrix.flatMap((d) =>
      themes.map((theme) => ({
        name: `shots-${d.name}-${theme}`,
        testMatch: /screens\.spec\.ts/,
        use: { ...d.use, colorScheme: theme, browserName: 'chromium' as const },
        metadata: { device: d.name, theme },
      })),
    ),
  ],
  webServer: [
    {
      name: 'api',
      command: `npx tsx ${envFile} src/server.ts`,
      cwd: '..',
      url: `${API}/readyz`,
      env: { PORT: '3100', METRICS_PORT: '9200', SYSTEM_COOLDOWN_SECONDS: '5', LOG_LEVEL: 'warn' },
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      name: 'worker',
      command: `npx tsx ${envFile} src/worker/main.ts`,
      cwd: '..',
      url: 'http://127.0.0.1:9201/readyz',
      env: { WORKER_HTTP_PORT: '9201', PROVIDER_URL: PROVIDER, NOTIFICATION_SINK_URL: `${PROVIDER}/notifications`, WORKER_POLL_INTERVAL_MS: '200', LOG_LEVEL: 'warn' },
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      name: 'provider',
      command: `npx tsx ${envFile} mock-provider/server.ts`,
      cwd: '..',
      url: `${PROVIDER}/healthz`,
      env: { PROVIDER_PORT: '4200', LEDGER_WEBHOOK_URL: `${API}/webhooks/provider` },
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
    {
      name: 'web',
      command: 'npx next start --port 3200 --hostname 127.0.0.1',
      url: `${WEB}/api/healthz`,
      env: {
        LEDGER_API_URL: API,
        LEDGER_INTERNAL_URL: INTERNAL,
        PROVIDER_URL: PROVIDER,
        ASSISTANT_MODE: 'fixtures',
        SESSION_SECRET: 'e2e-session-secret-at-least-32-characters-long',
      },
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
  ],
});
