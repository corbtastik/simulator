// Centralized config (env + sane defaults)
import 'dotenv/config';

export const CONFIG = {
  MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
  DB_NAME: process.env.DB_NAME ?? 'incidents',
  COLL_NAME: process.env.COLL_NAME ?? 'incident_events',

  PORT: Number(process.env.PORT ?? 5050),
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173',

  STATUS_WINDOW_SEC: Number(process.env.STATUS_WINDOW_SEC ?? 10),
  STATUS_POLL_MS: Number(process.env.STATUS_POLL_MS ?? 2500),

  // data
  CITY_JSON_PATH: process.env.CITY_JSON_PATH ?? new URL('../data/us-cities.json', import.meta.url).pathname,

  // guards/limits
  MAX_CONCURRENCY: Number(process.env.MAX_CONCURRENCY ?? 128),
  MAX_BATCH_SIZE: Number(process.env.MAX_BATCH_SIZE ?? 50000),
  MAX_EPS: Number(process.env.MAX_EPS ?? 1_000_000),
};
