import { MongoClient } from 'mongodb';
import { CONFIG } from './config.js';

let client;
let db;
let coll;

export async function connectDB() {
  if (client) return { client, db, coll };
  client = new MongoClient(CONFIG.MONGODB_URI, { maxPoolSize: 20 });
  await client.connect();
  db = client.db(CONFIG.DB_NAME);
  coll = db.collection(CONFIG.COLL_NAME);
  // Helpful index for time-series-ish demos
  await coll.createIndex({ ts: 1 });
  await coll.createIndex({ 'loc.coordinates': '2dsphere' }, { name: 'geo2dsphere', sparse: true }).catch(() => {});
  await coll.createIndex({ city: 1, ts: -1 }).catch(() => {});
  return { client, db, coll };
}

export async function closeDB() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
    coll = undefined;
  }
}
