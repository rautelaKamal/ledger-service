// Migration CLI:  npm run migrate   (in the container: node dist/scripts/migrate.js)
// The runner itself (with the advisory lock) lives in src/migrations.ts.
import { pathToFileURL } from 'node:url';
import { runMigrations } from '../src/migrations.js';

export { runMigrations };

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.OWNER_DATABASE_URL;
  if (!url) {
    console.error('OWNER_DATABASE_URL is not set (copy .env.example to .env)');
    process.exit(1);
  }
  const applied = await runMigrations(url, {
    onLockWait: (waiting) => {
      if (waiting) console.log('Another migration run holds the lock; waiting for it to finish...');
    },
  });
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply; database is up to date.');
}
