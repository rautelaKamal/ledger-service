import { defineConfig, devices } from '@playwright/test';
import { assertE2eDatabase } from './e2e/demo-db';

// The whole stack, started by Playwright: ledger API (+ its internal port), outbox
// worker, mock payment provider, and this web app (built first: `npm run build`).
// Locally the services read ../.env.e2e.local (a separate ledger_e2e database);
// in CI the workflow provides the same variables. Ports avoid the usual dev ones.
const API = 'http://127.0.0.1:3100';
const INTERNAL = 'http://127.0.0.1:9200';
const PROVIDER = 'http://127.0.0.1:4200';
const WEB = 'http://127.0.0.1:3200';
// Step 7g: the same web app in live mode, against a stand-in agent (e2e/mock-agent.mjs)
// and Redis; and once more with Redis unreachable, to prove the fail-safe.
const WEB_LIVE = 'http://127.0.0.1:3201';
const WEB_NO_REDIS = 'http://127.0.0.1:3202';
const MOCK_AGENT = 'http://127.0.0.1:8201';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const live = {
  LEDGER_API_URL: 'http://127.0.0.1:3100',
  LEDGER_INTERNAL_URL: 'http://127.0.0.1:9200',
  PROVIDER_URL: 'http://127.0.0.1:4200',
  ASSISTANT_MODE: 'agent',
  AGENT_URL: MOCK_AGENT,
  ASSISTANT_REDIS_PREFIX: 'e2e-assistant',
  ASSISTANT_BURST: '2',
  ASSISTANT_REFILL_SECONDS: '600',
  ASSISTANT_DAILY_CAP: '100',
  SESSION_SECRET: 'e2e-session-secret-at-least-32-characters-long',
};
const ci = Boolean(process.env.CI);
const envFile = '--env-file-if-exists=.env.e2e.local';

// Refuse to start the stack against anything but ledger_e2e (the eval reads `ledger`).
assertE2eDatabase();
// Never reuse a server that is already listening on these ports: the browsable demo
// (ledger_demo) uses the same ones, and tests sent to it would write into the demo.
// A running demo makes the run fail at once ("port already used") instead.
const reuseExistingServer = false;

const devicesMatrix = [
  { name: 'desktop', use: { viewport: { width: 1366, height: 900 } } },
  { name: 'phone', use: { ...devices['Pixel 7'] } },
] as const;
const themes = ['light', 'dark'] as const;

export default defineConfig({
  testDir: './e2e',
  // Every run starts from the seed and leaves the demo as the seed made it.
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1, // one shared ledger: flows run in order
  retries: 0,
  forbidOnly: ci,
  // In CI also 'github': each failure becomes an annotation on the run, readable without the logs.
  reporter: ci ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: WEB, trace: 'retain-on-failure', locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  projects: [
    { name: 'flows', testMatch: /flows\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'live', testMatch: /live\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'lighthouse', testMatch: /lighthouse\.spec\.ts/ },
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
      reuseExistingServer,
      timeout: 60_000,
    },
    {
      name: 'worker',
      command: `npx tsx ${envFile} src/worker/main.ts`,
      cwd: '..',
      url: 'http://127.0.0.1:9201/readyz',
      env: { WORKER_HTTP_PORT: '9201', PROVIDER_URL: PROVIDER, NOTIFICATION_SINK_URL: `${PROVIDER}/notifications`, WORKER_POLL_INTERVAL_MS: '200', LOG_LEVEL: 'warn' },
      reuseExistingServer,
      timeout: 60_000,
    },
    {
      name: 'provider',
      command: `npx tsx ${envFile} mock-provider/server.ts`,
      cwd: '..',
      url: `${PROVIDER}/healthz`,
      env: { PROVIDER_PORT: '4200', LEDGER_WEBHOOK_URL: `${API}/webhooks/provider` },
      reuseExistingServer,
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
      reuseExistingServer,
      timeout: 60_000,
    },
    {
      name: 'mock-agent',
      command: 'node e2e/mock-agent.mjs',
      url: `${MOCK_AGENT}/healthz`,
      env: { MOCK_AGENT_PORT: '8201' },
      reuseExistingServer,
      timeout: 30_000,
    },
    {
      name: 'web-live',
      command: 'npx next start --port 3201 --hostname 127.0.0.1',
      url: `${WEB_LIVE}/api/healthz`,
      env: { ...live, REDIS_URL },
      reuseExistingServer,
      timeout: 60_000,
    },
    {
      name: 'web-no-redis',
      command: 'npx next start --port 3202 --hostname 127.0.0.1',
      url: `${WEB_NO_REDIS}/api/healthz`,
      // Port 1: nothing listens there, as when the Redis pod is gone.
      env: { ...live, REDIS_URL: 'redis://127.0.0.1:1' },
      reuseExistingServer,
      timeout: 60_000,
    },
  ],
});
