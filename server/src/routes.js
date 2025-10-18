// server/routes.js
import express from 'express';
import { getStatus, startSimulator, stopSimulator } from './simulator.js';
import { connectDB, ensureSimRunsIndexes } from './db.js';

// Ensure DB + indexes once when routes are built
let bootstrapped = false;
async function bootstrapDbOnce() {
  if (bootstrapped) return;
  const { db } = await connectDB();
  await ensureSimRunsIndexes(db).catch(err => {
    console.error('[routes] ensureSimRunsIndexes failed:', err);
  });
  bootstrapped = true;
}

export function buildRoutes() {
  const router = express.Router();

  // Kick off DB/index bootstrap (don’t block route registration)
  bootstrapDbOnce().catch(err => {
    console.error('[routes] bootstrapDbOnce error:', err);
  });

  router.get('/status', async (_req, res) => {
    try {
      res.json(getStatus());
    } catch (e) {
      res.status(500).json({ error: e.message ?? 'status failed' });
    }
  });

  router.post('/start', async (req, res) => {
    try {
      const status = await startSimulator(req.body ?? {});
      res.json(status);
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message ?? 'start failed' });
    }
  });

  router.post('/stop', async (_req, res) => {
    try {
      // small timeout guard so the route doesn't hang if a driver call lingers
      const stopPromise = stopSimulator();
      const timeout = new Promise((_r, rej) =>
        setTimeout(() => rej(new Error('stop timeout')), 5000)
      );
      const status = await Promise.race([stopPromise, timeout]);
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message ?? 'stop failed' });
    }
  });

  return router;
}
