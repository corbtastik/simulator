// server/src/routes.js
import express from 'express';
import { getStatus, startSimulator, stopSimulator } from './simulator.js';
import {
  connectDB,
  ensureSimRunsIndexes,
  ensureFixEventsIndexes,
  countFixEvents,
} from './db.js';
import { repairScheduler } from './repairScheduler.js';

// Ensure DB + indexes once when routes are built
let bootstrapped = false;
async function bootstrapDbOnce() {
  if (bootstrapped) return;
  const { db } = await connectDB();
  await ensureSimRunsIndexes(db).catch(err => {
    console.error('[routes] ensureSimRunsIndexes failed:', err);
  });
  await ensureFixEventsIndexes(db).catch(err => {
    console.error('[routes] ensureFixEventsIndexes failed:', err);
  });
  bootstrapped = true;
}

export function buildRoutes() {
  const router = express.Router();

  // Kick off DB/index bootstrap (don’t block route registration)
  bootstrapDbOnce().catch(err => {
    console.error('[routes] bootstrapDbOnce error:', err);
  });

  router.get('/status', async (req, res) => {
    try {
      const simulator = getStatus();
      const scheduler = repairScheduler.status();

      // Optional: include a DB count of persisted fix_events for the current run
      let persistedDb = null;
      try {
        const { db } = await connectDB();
        const simRunId =
          simulator?.simRunId ||
          req.app.locals.getRunState?.()?.simRunId ||
          scheduler?.simRunId ||
          null;
        if (simRunId) {
          persistedDb = await countFixEvents(db, { simRunId });
        }
      } catch (err) {
        // soft-fail; keep status responsive
        console.warn('[routes]/status persistedDb error:', err?.message || err);
      }

      res.json({ ok: true, simulator, scheduler, persistedDb });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message ?? 'status failed' });
    }
  });

  router.post('/start', async (req, res) => {
    try {
      // Start the simulator first (persists sim_runs; carries note/repairsEnabled)
      const simulator = await startSimulator(req.body ?? {});
      const { repairsEnabled, repairConfig } = req.body ?? {};

      let scheduler = repairScheduler.status();

      // Conditionally start the repair scheduler (Phase 3-capable)
      if (repairsEnabled === true) {
        const run = req.app.locals.getRunState?.();
        scheduler = repairScheduler.start(
          { simRunId: run?.simRunId, params: { seed: run?.params?.seed } },
          // repairConfig may include: { cadenceMs, budgetPerTick, policy, version, recentWindowSec, persist }
          repairConfig
        );
      }

      // Also return current DB count for convenience
      const { db } = await connectDB();
      const persistedDb = simulator?.simRunId
        ? await countFixEvents(db, { simRunId: simulator.simRunId })
        : null;

      res.json({ ok: true, simulator, scheduler, persistedDb });
    } catch (e) {
      res.status(e.status ?? 500).json({ ok: false, error: e.message ?? 'start failed' });
    }
  });

  router.post('/stop', async (req, res) => {
    try {
      // Stop scheduler first (idempotent)
      await repairScheduler.stop();

      // Small timeout guard so the route doesn't hang if a driver call lingers
      const stopPromise = stopSimulator();
      const timeout = new Promise((_r, rej) =>
        setTimeout(() => rej(new Error('stop timeout')), 5000)
      );
      const simulator = await Promise.race([stopPromise, timeout]);

      const scheduler = repairScheduler.status();

      // Include a final persisted DB count for the last run if we still know it
      let persistedDb = null;
      try {
        const { db } = await connectDB();
        const simRunId =
          simulator?.simRunId || req.app.locals.getRunState?.()?.simRunId || null;
        if (simRunId) {
          persistedDb = await countFixEvents(db, { simRunId });
        }
      } catch (err) {
        console.warn('[routes]/stop persistedDb error:', err?.message || err);
      }

      res.json({ ok: true, simulator, scheduler, persistedDb });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message ?? 'stop failed' });
    }
  });

  return router;
}
