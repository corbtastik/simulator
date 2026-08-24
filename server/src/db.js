// server/src/db.js
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

  // Helpful indexes for your inserts + queries (ingest collection)
  await coll.createIndex({ ts: 1 }).catch(() => {});
  await coll
    .createIndex({ 'loc.coordinates': '2dsphere' }, { name: 'geo2dsphere', sparse: true })
    .catch(() => {});
  await coll.createIndex({ city: 1, ts: -1 }).catch(() => {});

  // Ensure uniqueness for ASP $merge of infrastructure resolutions:
  // $merge.on: ["incidentId","type"] with whenMatched: "keepExisting"
  // We scope uniqueness to { type: "resolution" } to avoid colliding with incident docs.
  await ensureInfraResolutionIndex(db);

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

  // 2) Query helpers for events per run on the ingest collection.
  //    Prefer ts over _id for time-sorted reads.
  await _db.collection(CONFIG.COLL_NAME).createIndex({ simRunId: 1, ts: -1 }, { name: 'simRunId_ts' });
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

/* ------------------------------------------------------------------
 * Phase 3/4: fix_events persistence helpers & indexes (NEW SHAPE)
 * ------------------------------------------------------------------*/

/**
 * Ensure indexes for incidents.fix_events (current schema).
 *
 * - Unique: one fix per (simRunId, incidentId)
 * - Helper:   { simRunId: 1, ts: -1 }
 * - Optional TTL on ts if FIX_TTL_DAYS > 0
 *
 * NOTE: This intentionally does NOT create the old deterministicKey/decidedAt indexes.
 *       If those exist from previous runs, drop them once manually or via a migration.
 */
export async function ensureFixEventsIndexes(passedDb) {
  const _db = passedDb || getDb();
  const fixColl = _db.collection(CONFIG.FIX_COLL_NAME);

  // Uniqueness: one event per type per incident per run
  // (allows both repair_started and fix events for same incident)
  await fixColl.createIndex(
    { simRunId: 1, incidentId: 1, type: 1 },
    { name: 'uniq_event_per_run_incident_type', unique: true }
  );

  // Query helper: newest fixes within a run
  await fixColl.createIndex({ simRunId: 1, ts: -1 }, { name: 'fix_by_run_ts' });

  // TTL (optional) — base on ts
  const ttlDays = Number(CONFIG.FIX_TTL_DAYS ?? 0);
  if (Number.isFinite(ttlDays) && ttlDays > 0) {
    await fixColl.createIndex(
      { ts: 1 },
      { name: 'ttl_ts', expireAfterSeconds: ttlDays * 24 * 60 * 60 }
    );
  }
}

/**
 * Insert a fix_event with insert-only semantics.
 * Duplicate key errors (E11000) are treated as duplicate: true.
 */
export async function insertFixEvent(passedDb, doc) {
  const _db = passedDb || getDb();
  const fixColl = _db.collection(CONFIG.FIX_COLL_NAME);
  try {
    const res = await fixColl.insertOne(doc);
    return { ok: true, inserted: !!res?.acknowledged, duplicate: false };
  } catch (err) {
    if (err?.code === 11000) {
      return { ok: true, inserted: 0, duplicate: true };
    }
    // Log non-dup errors so caller doesn't miscount them as duplicates
    console.error('[db.insertFixEvent] error:', err?.message || err);
    throw err;
  }
}

/**
 * Count fix_events (optionally filtered by simRunId).
 */
export async function countFixEvents(passedDb, { simRunId } = {}) {
  const _db = passedDb || getDb();
  const fixColl = _db.collection(CONFIG.FIX_COLL_NAME);
  const filter = simRunId ? { simRunId } : {};
  return fixColl.countDocuments(filter);
}

/* ------------------------------------------------------------------
 * Phase 4: infrastructure_events resolution uniqueness for ASP $merge
 * ------------------------------------------------------------------*/

/**
 * Ensure unique index to support ASP $merge into incidents.infrastructure_events
 * using:
 *   on: ["incidentId", "type"]
 *   whenMatched: "keepExisting"
 *   whenNotMatched: "insert"
 *
 * We scope uniqueness to { type: "resolution" } so incident docs don't conflict.
 */
export async function ensureInfraResolutionIndex(passedDb) {
  const _db = passedDb || getDb();
  const infraColl = _db.collection('infrastructure_events');
  try {
    await infraColl.createIndex(
      { incidentId: 1, type: 1 },
      {
        name: 'uniq_incidentId_type_resolution',
        unique: true,
        partialFilterExpression: { type: 'resolution' },
        background: true
      }
    );
  } catch (err) {
    // IndexOptionsConflict (code 85) if an index exists with different options.
    if (err?.codeName === 'IndexOptionsConflict' || err?.code === 85) {
      console.warn('[indexes] infra resolution index exists with different options:', err.message);
    } else {
      console.error('[indexes] failed ensuring infra resolution index:', err);
    }
  }
}

export async function closeDB() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
    coll = undefined;
  }
}

/* ------------------------------------------------------------------
 * incident_media collection helpers (multimodal image embeddings)
 * ------------------------------------------------------------------*/

/**
 * Ensure indexes for incident_media collection.
 * Note: Vector search index must be created in Atlas UI, not via driver.
 */
export async function ensureMediaIndexes(passedDb) {
  const _db = passedDb || getDb();
  const mediaColl = _db.collection(CONFIG.MEDIA_COLL_NAME);

  // Reference to parent incident
  await mediaColl.createIndex({ incidentId: 1 }, { name: 'media_incidentId' });

  // Query by sim run
  await mediaColl.createIndex({ simRunId: 1, ts: -1 }, { name: 'media_simRunId_ts' });

  // Query by media type and category
  await mediaColl.createIndex({ mediaType: 1, category: 1 }, { name: 'media_type_category' });

  console.log('[db] incident_media indexes ensured');
}

/**
 * Insert a media document
 */
export async function insertMediaDoc(passedDb, doc) {
  const _db = passedDb || getDb();
  return _db.collection(CONFIG.MEDIA_COLL_NAME).insertOne(doc);
}

/**
 * Count media documents (optionally filtered by simRunId)
 */
export async function countMediaDocs(passedDb, { simRunId } = {}) {
  const _db = passedDb || getDb();
  const filter = simRunId ? { simRunId } : {};
  return _db.collection(CONFIG.MEDIA_COLL_NAME).countDocuments(filter);
}

/**
 * Vector search on incident_media collection
 * @param {number[]} queryVector - 1024-dimensional embedding vector
 * @param {Object} options - Search options
 * @param {string} [options.simRunId] - Filter by simulation run
 * @param {string} [options.category] - Filter by incident category
 * @param {number} [options.limit=10] - Max results to return
 * @param {number} [options.numCandidates=100] - Candidates to consider
 * @returns {Promise<Array>} - Matching media documents with scores
 */
export async function vectorSearchMedia(passedDb, queryVector, options = {}) {
  const _db = passedDb || getDb();
  const { simRunId, category, limit = 10, numCandidates = 100 } = options;

  // Build filter for pre-filtering (if provided)
  const filter = {};
  if (simRunId) filter.simRunId = simRunId;
  if (category) filter.category = category;

  const pipeline = [
    {
      $vectorSearch: {
        index: 'incident_media_vector',
        path: 'embedding',
        queryVector,
        numCandidates,
        limit,
        ...(Object.keys(filter).length > 0 ? { filter } : {})
      }
    },
    {
      $project: {
        _id: 1,
        incidentId: 1,
        simRunId: 1,
        category: 1,
        type: 1,
        filename: 1,
        source: 1,
        dataset: 1,
        caption: 1,
        ts: 1,
        score: { $meta: 'vectorSearchScore' }
      }
    }
  ];

  return _db.collection(CONFIG.MEDIA_COLL_NAME).aggregate(pipeline).toArray();
}
