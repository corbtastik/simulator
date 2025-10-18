// server/server.js
import express from 'express';
import cors from 'cors';
import { CONFIG } from './config.js';
import { buildRoutes } from './routes.js';
import { initSimulator } from './simulator.js';
import { closeDB } from './db.js';

// Optional: expose runState on app.locals for easy access in routes/status pages
import { getRunState } from './runState.js';

async function main() {
  await initSimulator();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cors({ origin: CONFIG.ALLOWED_ORIGIN }));

  // make run state visible to any middleware/route via req.app.locals
  app.locals.getRunState = getRunState;

  app.use('/', buildRoutes());

  const server = app.listen(CONFIG.PORT, () => {
    console.log(`[server] listening on http://localhost:${CONFIG.PORT}`);
  });

  const shutdown = async (sig) => {
    console.log(`[server] ${sig} received, shutting down...`);
    server.close(async () => {
      await closeDB();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[server] fatal', e);
  process.exit(1);
});
