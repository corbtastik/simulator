// server/src/server.js
import express from 'express';
import cors from 'cors';
import { CONFIG } from './config.js';
import { buildRoutes } from './routes.js';
import { initSimulator, stopSimulator } from './simulator.js';
import { closeDB } from './db.js';

// Optional: expose runState on app.locals for easy access in routes/status pages
import { getRunState } from './runState.js';

async function main() {
  // Initialize simulator subsystem (workers, state, etc.)
  await initSimulator();

  const app = express();

  // Core middleware
  app.use(express.json({ limit: '1mb' }));
  app.use(cors({ origin: CONFIG.ALLOWED_ORIGIN }));

  // Make run state visible to any middleware/route via req.app.locals
  app.locals.getRunState = getRunState;

  // Health probe (useful for local and CI)
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // API routes
  app.use('/', buildRoutes());

  const server = app.listen(CONFIG.PORT, () => {
    console.log(`[server] listening on http://localhost:${CONFIG.PORT}`);
  });

  const shutdown = async (sig) => {
    console.log(`[server] ${sig} received, shutting down...`);
    try {
      // Gracefully stop the simulator first (idempotent)
      await stopSimulator({ reason: sig });
    } catch (e) {
      console.warn('[server] stopSimulator encountered an issue (continuing shutdown):', e);
    }

    server.close(async () => {
      try {
        await closeDB();
      } catch (e) {
        console.warn('[server] closeDB encountered an issue (continuing exit):', e);
      } finally {
        process.exit(0);
      }
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[server] fatal', e);
  process.exit(1);
});
