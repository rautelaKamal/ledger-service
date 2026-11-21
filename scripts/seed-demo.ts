// The web demo's fictional people, once:  npm run seed:demo   (compose: `run --rm seed-demo`)
// Does nothing when they already exist. See src/demo/seed.ts; to start over, npm run demo:reset.
import pg from 'pg';
import { seedDemo } from '../src/demo/seed.js';

const url = process.env.OWNER_DATABASE_URL;
if (!url) {
  console.error('OWNER_DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const summary = await seedDemo(client);
  await client.query('COMMIT');
  console.log(summary ? summary.join('\n') : 'demo data already present: nothing to do');
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
