// Centralized config (env + sane defaults)
import 'dotenv/config';

// tiny helper
const envBool = (v, def = false) =>
  (v === undefined || v === null) ? def : String(v).toLowerCase() === 'true';

export const CONFIG = {
  MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
  DB_NAME: process.env.DB_NAME ?? 'incidents',
  COLL_NAME: process.env.COLL_NAME ?? 'incident_events',

  PORT: Number(process.env.PORT ?? 5050),
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173',

  STATUS_WINDOW_SEC: Number(process.env.STATUS_WINDOW_SEC ?? 10),
  STATUS_POLL_MS: Number(process.env.STATUS_POLL_MS ?? 2500),

  // data
  CITY_JSON_PATH:
    process.env.CITY_JSON_PATH ??
    new URL('../data/us-cities.json', import.meta.url).pathname,

  // guards/limits
  MAX_CONCURRENCY: Number(process.env.MAX_CONCURRENCY ?? 128),
  MAX_BATCH_SIZE: Number(process.env.MAX_BATCH_SIZE ?? 50000),
  MAX_EPS: Number(process.env.MAX_EPS ?? 1_000_000),

  // --- Phase 3: fix_events persistence ---
  // Target collection for Phase 3 ingest (incidents.<FIX_COLL_NAME>)
  FIX_COLL_NAME: process.env.FIX_COLL_NAME ?? 'fix_events',

  // TTL in days for fix_events.decidedAt. Set to 0 to disable TTL index.
  FIX_TTL_DAYS: Number(process.env.FIX_TTL_DAYS ?? 30),

  // Uniqueness strategy: "deterministicKey" (recommended) or "compound"
  FIX_UNIQUE_MODE: process.env.FIX_UNIQUE_MODE ?? 'deterministicKey',

  // Default feature flag for persistence (can be overridden per /start via repairConfig.persist)
  FIX_PERSIST_DEFAULT: envBool(process.env.FIX_PERSIST_DEFAULT, false),

  REPAIR: {
    // scheduler loop
    cadenceMs: 1000,
    budgetPerTick: 5,
    recentWindowSec: 30,

    // delay model
    delayMedianSec: 60,      // 1 minute median delay
    delayP95Sec: 150,        // 2.5 minutes delay at 95th percentile
    delayJitterSec: 10,
    pFixProbability: 0.92,   // 92% of incidents get fixed in-window

    // safety cap (seconds). You can also set REPAIR_MAX_DELAY_SEC env var.
    maxDelaySec: 300         // 5 minutes max delay
  }
};

// Build a stable run id like "20251018-1830Z-s1"
export function buildSimRunId(seed) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  // seconds omitted to keep runs grouped by minute; add if you prefer
  const z = 'Z';
  const seedPart = (seed === undefined || seed === null) ? 'srand' : `s${seed}`;
  return `${y}${m}${day}-${hh}${mm}${z}-${seedPart}`;
}
