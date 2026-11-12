// Reconciliation:  npm run reconcile [-- --out path/to/report.json]
//
// Connects as ledger_reconciler, runs every read-only check, prints a report,
// writes it as JSON, records one row in reconciliation_runs, and exits 1 if
// anything is wrong. (The Kubernetes CronJob and the S3 upload come in step 6.)
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { createPool } from '../db.js';
import { formatReport, recordRun, runReconciliation } from './run.js';

const EnvSchema = z.object({
  RECONCILER_DATABASE_URL: z.string().startsWith('postgres://'),
  RECONCILE_STALE_TOPUP_HOURS: z.coerce.number().positive().default(24),
  RECONCILE_OUTBOX_PENDING_MINUTES: z.coerce.number().positive().default(60),
});

const env = EnvSchema.safeParse(process.env);
if (!env.success) {
  console.error(`Invalid reconciliation environment:\n${z.prettifyError(env.error)}`);
  process.exit(1);
}

const outIndex = process.argv.indexOf('--out');
const outPath = outIndex !== -1 ? process.argv[outIndex + 1] : 'reconcile-report.json';
if (!outPath) {
  console.error('--out needs a path');
  process.exit(1);
}

const pool = createPool(env.data.RECONCILER_DATABASE_URL, { max: 2 });
try {
  const report = await runReconciliation(pool, {
    staleTopupAfterMs: env.data.RECONCILE_STALE_TOPUP_HOURS * 60 * 60_000,
    outboxPendingAfterMs: env.data.RECONCILE_OUTBOX_PENDING_MINUTES * 60_000,
  });
  console.log(formatReport(report));
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
  const runId = await recordRun(pool, report);
  console.log(`report written to ${outPath}; recorded as reconciliation run ${runId}`);
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await pool.end();
}
