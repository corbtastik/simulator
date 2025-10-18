import express from 'express';
import { getStatus, startSimulator, stopSimulator } from './simulator.js';

export function buildRoutes() {
  const router = express.Router();

  router.get('/status', async (req, res) => {
    res.json(getStatus());
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
    const status = await stopSimulator();
    res.json(status);
  });

  return router;
}
