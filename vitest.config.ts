import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs once, in the main process, before any test file:
    // loads .env.test, migrates ledger_test, truncates the tables.
    globalSetup: ['./tests/global-setup.ts'],
    // Runs inside every test worker, so the workers also see .env.test.
    setupFiles: ['./tests/load-env.ts'],
    // All test files share ONE database (ledger_test). Running files in
    // parallel would let one file see (or wipe) another file's rows.
    fileParallelism: false,
    // Application logs (pino) are silent in tests, so the test output stays readable.
    // Tests that check log lines capture them with useLogger() instead.
    env: { LOG_LEVEL: 'silent' },
    include: ['tests/**/*.test.ts'],
  },
});
