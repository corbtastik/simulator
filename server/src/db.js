// server/db.js
import { MongoClient } from 'mongodb';
import { CONFIG } from './config.js';

let client;
let db;
let coll; // incidents.incident_events (CONFIG.COLL_NAME)

/**
 * Connect to MongoDB and prepare primary handles.
 * Also ensures a few helpful indexes on the ingest collection.
 */
export async function connectDB() {
  if (client) return { client, db, coll };

  client = new MongoClient(CONFIG.MONGODB_URI, { maxPoolSize: 20 });
  await client.connect();

  db = client.db(CONFIG.DB_NAME);
  coll = db.collection(CONFIG.COLL_NAME); // typically "incident_events"

  // Helpful indexes for your inserts + queries
  await coll.createIndex({ ts: 1 }).catch(() => {});
  await coll
    .createIndex({ 'loc.coordinates': '2dsphere' }, { name: 'geo2dsphere', sparse: true })
    .catch(() => {});
  await coll.createIndex({ city: 1, ts: -1 }).catch(() => {});

  return { client, db, coll };
}

/**
 * Convenience getters for other modules (routes, simulator, etc.)
 * Assumes connectDB() has been called during server bootstrap.
 */
export function getDb() {
  if (!db) throw new Error('DB not initialized. Call connectDB() first.');
  return db;
}
export function getCollection() {
  if (!coll) throw new Error('Collection not initialized. Call connectDB() first.');
  return coll;
}
export function getClient() {
  if (!client) throw new Error('Client not initialized. Call connectDB() first.');
  return client;
}

/**
 * Ensure indexes related to sim runs and stamped events.
 * Call once on boot after connectDB().
 */
export async function ensureSimRunsIndexes(passedDb) {
  const _db = passedDb || getDb();

  // 1) Unique run identifier so we can audit/close runs cleanly.
  await _db.collection('sim_runs').createIndex({ simRunId: 1 }, { unique: true });

  // 2) Query helpers for events per run.
  await _db.collection(CONFIG.COLL_NAME).createIndex({ simRunId: 1, _id: 1 });
}

/**
 * Insert a new sim_runs document at start of a run.
 */
export async function insertSimRun(passedDb, doc) {
  const _db = passedDb || getDb();
  return _db.collection('sim_runs').insertOne(doc);
}

/**
 * Mark a sim run as ended (sets endedAt).
 */
export async function endSimRun(passedDb, simRunId) {
  const _db = passedDb || getDb();
  return _db.collection('sim_runs').updateOne(
    { simRunId },
    { $set: { endedAt: new Date() } }
  );
}

export async function closeDB() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
    coll = undefined;
  }
}
