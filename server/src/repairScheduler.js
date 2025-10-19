// server/src/repairScheduler.js
// Phase-2 preview-only Repair Scheduler (no DB writes)
//
// API:
//   repairScheduler.start(simRunContext, config?)
//   repairScheduler.stop()
//   repairScheduler.status()
//
// Behavior:
// - Deterministic (seeded) selection of recent incidents for WOULD_FIX previews.
// - "infra-first" policy by default; can be extended later.
// - Emits JSON line logs to stdout, nothing persisted yet.

import { connectDB } from './db.js';
import { makeRNG } from './rng.js';

const DEFAULTS = {
  cadenceMs: 1000,           // tick every 1s
  budgetPerTick: 5,          // max candidates to emit per tick
  policy: 'infra-first',     // placeholder for future strategies
  version: '2.0.0-phase2',   // surfaced in logs/status
  recentWindowSec: 30,       // look back this many seconds when choosing candidates
};

// Heuristic set for "infrastructure" types we already use around the project.
// If types differ at runtime, we gracefully fall back to "unknown".
const INFRA_TYPES = new Set([
  'construction', 'smartcell', 'smallcell', 'backhaul',
  'datacenter', 'cloud-network', 'cloud_network', 'edge',
  'tower', 'fiber-plant', 'fiber', 'core', 'transport'
]);

const SCHED = {
  state: 'idle',            // 'idle' | 'running' | 'stopping'
  simRunId: null,
  version: DEFAULTS.version,
  policy: DEFAULTS.policy,
  cadenceMs: DEFAULTS.cadenceMs,
  budgetPerTick: DEFAULTS.budgetPerTick,
  recentWindowSec: DEFAULTS.recentWindowSec,

  // deterministic RNG
  rng: null,

  // loop control
  timer: null,
  ticking: false,           // prevents overlapping ticks

  // metrics
  ticks: 0,
  candidatesEmitted: 0,

  // last snapshot
  lastTickAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

function chooseCategoryFrom(issue) {
  // Phase-2 only needs "infrastructure" for preview.
  // If we can infer from serviceIssue.type, do it; else default 'infrastructure'.
  const t = issue?.type?.toString().toLowerCase();
  if (t && INFRA_TYPES.has(t)) return 'infrastructure';
  // soft inference: certain substrings count as infra
  if (t && /cell|tower|fiber|backhaul|datacenter|edge|transport|core/.test(t)) {
    return 'infrastructure';
  }
  return 'infrastructure';
}

async function fetchRecentIncidents(simRunId, limit, recentWindowSec) {
  const { coll } = await connectDB();
  const since = new Date(Date.now() - recentWindowSec * 1000);

  // Pull a small recent set to pick from; requires { ts: 1 } index (already ensured)
  // and benefits from { simRunId: 1, _id: 1 } index (db.ensureSimRunsIndexes).
  const cursor = coll.find(
    { simRunId, ts: { $gte: since } },
    {
      sort: { ts: -1 },
      limit: Math.max(limit, 1),
      projection: { _id: 1, ts: 1, serviceIssue: 1 },
    }
  );

  return cursor.toArray();
}

// Fisher-Yates-style index walk using RNG to select items without replacement
function* deterministicPicker(rngFn, items) {
  const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i >= 0; i--) {
    const j = Math.floor(rngFn() * (i + 1));
    const k = idx[j];
    [idx[i], idx[j]] = [idx[j], idx[i]];
    yield items[k];
  }
}

async function tick() {
  if (SCHED.ticking || SCHED.state !== 'running') return;
  SCHED.ticking = true;

  try {
    const batchHint = SCHED.budgetPerTick * 5; // small over-fetch so policy can filter
    const pool = await fetchRecentIncidents(SCHED.simRunId, batchHint, SCHED.recentWindowSec);

    // Filter per policy (infra-first). In Phase-2 we only preview infra candidates.
    const infraPool = pool.filter((d) => chooseCategoryFrom(d.serviceIssue) === 'infrastructure');

    // Deterministic selection up to budget
    const picker = deterministicPicker(SCHED.rngFn, infraPool);
    let emitted = 0;

    for (const d of picker) {
      if (emitted >= SCHED.budgetPerTick) break;

      const category = 'infrastructure';
      // Deterministic key can help with later de-dup/joins in logs
      const deterministicKey = `${SCHED.simRunId}:${category}:${d._id.toString()}:${SCHED.version}`;

      // Emit JSON line to stdout (preview-only)
      // Keep it single-line and structured for easy tailing/grepping.
      const log = {
        simRunId: SCHED.simRunId,
        ts: nowIso(),
        category,
        incidentId: d._id,
        action: 'WOULD_FIX',
        reason: 'infra-first: recent && sample', // placeholder; can expand later
        policy: SCHED.policy,
        version: SCHED.version,
        deterministicKey,
      };
      // Prefix makes it easy to filter: grep/JSON parse in tools
      // eslint-disable-next-line no-console
      console.log('[repair]', JSON.stringify(log));

      emitted += 1;
    }

    SCHED.candidatesEmitted += emitted;
    SCHED.ticks += 1;
    SCHED.lastTickAt = new Date();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[repairScheduler] tick error (continuing):', err?.message || err);
  } finally {
    SCHED.ticking = false;
  }
}

function startLoop() {
  if (SCHED.timer) clearInterval(SCHED.timer);
  SCHED.timer = setInterval(tick, SCHED.cadenceMs);
}

function stopLoop() {
  if (SCHED.timer) {
    clearInterval(SCHED.timer);
    SCHED.timer = null;
  }
}

export const repairScheduler = {
  /**
   * Start the preview-only repair scheduler.
   * @param {object} simRunContext - e.g. { simRunId, params: { seed, ... } }
   * @param {object} cfg - optional overrides (cadenceMs, budgetPerTick, policy, version, recentWindowSec)
   */
  start(simRunContext, cfg = {}) {
    // Idempotent start
    if (SCHED.state === 'running' && SCHED.simRunId === simRunContext?.simRunId) {
      return this.status();
    }

    const simRunId = simRunContext?.simRunId;
    const seed = simRunContext?.params?.seed ?? null;
    if (!simRunId) {
      throw Object.assign(new Error('repairScheduler.start: missing simRunId'), { status: 400 });
    }

    // Merge config
    SCHED.cadenceMs = Number(cfg.cadenceMs ?? DEFAULTS.cadenceMs);
    SCHED.budgetPerTick = Number(cfg.budgetPerTick ?? DEFAULTS.budgetPerTick);
    SCHED.policy = String(cfg.policy ?? DEFAULTS.policy);
    SCHED.version = String(cfg.version ?? DEFAULTS.version);
    SCHED.recentWindowSec = Number(cfg.recentWindowSec ?? DEFAULTS.recentWindowSec);

    // Deterministic RNG (derive even when seed is null by using a fixed fallback)
    const finalSeed = Number.isFinite(+seed) ? +seed : 0xC0FFEE;
    const { rand } = makeRNG(finalSeed);

    // Reset state
    SCHED.state = 'running';
    SCHED.simRunId = simRunId;
    SCHED.rngFn = rand;
    SCHED.ticks = 0;
    SCHED.candidatesEmitted = 0;
    SCHED.lastTickAt = null;

    startLoop();
    return this.status();
  },

  /**
   * Stop the scheduler (idempotent). Waits for an in-flight tick to finish.
   */
  async stop() {
    if (SCHED.state === 'idle') return this.status();
    SCHED.state = 'stopping';

    // Wait briefly if a tick is in progress
    const GUARD_MS = 1000;
    const start = Date.now();
    while (SCHED.ticking && Date.now() - start < GUARD_MS) {
      await new Promise((r) => setTimeout(r, 15));
    }

    stopLoop();

    // Reset lightweight state; keep last metrics for status
    SCHED.state = 'idle';
    SCHED.simRunId = null;
    SCHED.rng = null;

    return this.status();
  },

  /**
   * Current scheduler status snapshot.
   */
  status() {
    return {
      state: SCHED.state,
      simRunId: SCHED.simRunId,
      cadenceMs: SCHED.cadenceMs,
      budgetPerTick: SCHED.budgetPerTick,
      policy: SCHED.policy,
      version: SCHED.version,
      recentWindowSec: SCHED.recentWindowSec,
      ticks: SCHED.ticks,
      candidatesEmitted: SCHED.candidatesEmitted,
      lastTickAt: SCHED.lastTickAt,
    };
  },
};
