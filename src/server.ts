import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = createApp(pool);

const server = app.listen(config.PORT, () => {
  console.log(`ledger-service listening on http://localhost:${config.PORT}`);
});

// Close the HTTP server and the database pool cleanly on Ctrl+C / container stop.
function shutdown(): void {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
