// server/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const {
  MONGODB_URI,
  DB_NAME = 'uber',
  COLL_NAME = 'pickups_sim',
  PORT = 5050,
  ALLOWED_ORIGIN = 'http://localhost:5173'
} = process.env;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in .env');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: ALLOWED_ORIGIN }));

// ---- Mongo ----
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(DB_NAME);
const coll = db.collection(COLL_NAME);

// Helpful indexes
await coll.createIndex({ ts: 1 });
await coll.createIndex({ loc: '2dsphere' });
// Optional: useful for dashboards/filters on issue type
await coll.createIndex({ 'serviceIssue.type': 1, ts: 1 });

console.log(`Connected to MongoDB → ${DB_NAME}.${COLL_NAME}`);

// Harden process
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

// ---- City model (load once from disk) ----
let CITY_MODEL = [];
let CUM_WEIGHTS = [];
let TOTAL_WEIGHT = 0;

function buildWeights() {
  CUM_WEIGHTS = new Array(CITY_MODEL.length);
  let acc = 0;
  for (let i = 0; i < CITY_MODEL.length; i++) {
    const w = Number(CITY_MODEL[i].weight ?? 1);
    acc += w > 0 ? w : 0;
    CUM_WEIGHTS[i] = acc;
  }
  TOTAL_WEIGHT = acc;
}

function loadCityModelFromDisk() {
  const p = path.join(__dirname, 'data', 'us-cities.json');
  const raw = fs.readFileSync(p, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('us-cities.json must be an array');
  CITY_MODEL = arr.filter(x => typeof x.lat === 'number' && typeof x.lng === 'number' && x.name);
  buildWeights();
  console.log(`Loaded city model: ${CITY_MODEL.length} cities (data/us-cities.json)`);
}

loadCityModelFromDisk();

// --- Throughput stats (1s rollups) ---
let STATS = { lastSecondInserts: 0, maWindow: 10, history: [] };
function movingAverage() {
  if (!STATS.history.length) return 0;
  const sum = STATS.history.reduce((a, b) => a + b, 0);
  return Math.round(sum / STATS.history.length);
}

// ---- RNG / Math helpers ----
const rand = (seedObj) => {
  if (!seedObj) return Math.random();
  seedObj.value = (1664525 * seedObj.value + 1013904223) % 4294967296;
  return seedObj.value / 4294967296;
};
function randFloat(min, max, seedObj) { return min + (max - min) * (rand(seedObj) || Math.random()); }
function randInt(min, max, seedObj) { return Math.floor(randFloat(min, max + 1, seedObj)); }
function choice(arr, seedObj) { return arr[randInt(0, arr.length - 1, seedObj)]; }
function kmToDegLat(km) { return km / 110.574; }
function kmToDegLng(km, latDeg) { return km / (111.320 * Math.cos((latDeg * Math.PI) / 180)); }
function randn(seedObj) {
  const r = () => rand(seedObj) || Math.random();
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// O(log N) weighted pick using cumulative weights
function pickWeightedCity(seedObj) {
  if (CITY_MODEL.length === 0 || TOTAL_WEIGHT <= 0) {
    throw new Error('City model is empty or has non-positive total weight.');
  }
  const target = (rand(seedObj) || Math.random()) * TOTAL_WEIGHT;
  let lo = 0, hi = CUM_WEIGHTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (CUM_WEIGHTS[mid] >= target) hi = mid; else lo = mid + 1;
  }
  return CITY_MODEL[lo];
}

function sampleAround({ lat, lng, sigmaKm = 10 }, spread = 1.0, seedObj) {
  const sx = sigmaKm * spread;
  const dxKm = randn(seedObj) * sx;
  const dyKm = randn(seedObj) * sx;
  const lng2 = lng + kmToDegLng(dxKm, lat);
  const lat2 = lat + kmToDegLat(dyKm);
  return { lat: lat2, lng: lng2 };
}

// ----- Polymorphic serviceIssue generators -----
function cityShort(city) {
  return (city?.name || 'CITY').split(/[ ,]/)[0].slice(0, 3).toUpperCase();
}
function cityTowerPrefix(city) {
  const n = (city?.name || '').toLowerCase();
  if (n.includes('dallas') || n.includes('fort worth')) return 'DFW-TWR';
  if (n.includes('austin')) return 'AUS-TWR';
  if (n.includes('san antonio')) return 'SAT-TWR';
  if (n.includes('houston')) return 'HOU-TWR';
  return `${cityShort(city)}-TWR`;
}
function nearestCityName(city) { return city?.name || 'Unknown'; }
function randomMac(seedObj) {
  const b = () => randInt(0, 255, seedObj);
  return [b(), b(), b(), b(), b(), b()].map(x => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

const ISSUE_FACTORIES = [
  {
    type: 'broadband', weight: 12,
    make: (city, seedObj) => ({
      type: 'broadband',
      accountId: `ATTB-${String(randInt(100, 999, seedObj))}`,
      issue: choice(['slow-speeds','intermittent','packet-loss'], seedObj),
      downstreamMbps: Number(randFloat(1.0, 50.0, seedObj).toFixed(1)),
      expectedMbps: choice([50, 100, 300, 1000], seedObj)
    })
  },
  {
    type: 'wireless', weight: 12,
    make: (city, seedObj) => ({
      type: 'wireless',
      phone: `+1-${randInt(201, 989, seedObj)}-${randInt(200, 999, seedObj)}-${String(randInt(1000, 9999, seedObj)).padStart(4,'0')}`,
      issue: choice(['no-signal','dropped-calls','data-stall'], seedObj),
      towerId: `${cityTowerPrefix(city)}-${randInt(100, 999, seedObj)}`,
      deviceModel: choice(['iPhone 15 Pro','Galaxy S24','Pixel 9 Pro','iPhone 14'], seedObj)
    })
  },
  {
    type: 'fiber', weight: 8,
    make: (city, seedObj) => ({
      type: 'fiber',
      accountId: `ATTF-${String(randInt(10, 999, seedObj)).padStart(3,'0')}`,
      issue: choice(['outage','light-level-low','splice-fault'], seedObj),
      outageStart: new Date(Date.now() - randInt(5, 180, seedObj) * 60 * 1000),
      region: nearestCityName(city)
    })
  },
  {
    type: '5g', weight: 7,
    make: (city, seedObj) => ({
      type: '5g',
      imei: String(randInt(300000000000000, 399999999999999, seedObj)),
      issue: choice(['handover-failure','throughput-drop','ta-high'], seedObj),
      cellSector: choice(['Sector-A','Sector-B','Sector-C'], seedObj),
      towerId: `${cityShort(city)}-5G-${String(randInt(1, 999, seedObj)).padStart(3,'0')}`
    })
  },
  {
    type: 'smallcell', weight: 6,
    make: (city, seedObj) => ({
      type: 'smallcell',
      nodeId: `SC-${cityShort(city)}-${randInt(100, 999, seedObj)}`,
      issue: choice(['power-loss','offline','gps-sync-loss'], seedObj),
      lastHeartbeat: new Date(Date.now() - randInt(1, 60, seedObj) * 60 * 1000)
    })
  },
  {
    type: 'wifi-hotspot', weight: 5,
    make: (city, seedObj) => ({
      type: 'wifi-hotspot',
      ssid: `attwifi-${cityShort(city).toUpperCase()}`,
      issue: choice(['authentication-failure','captive-portal-error','dhcp-fail'], seedObj),
      macAddress: randomMac(seedObj)
    })
  },
  {
    type: 'enterprise', weight: 5,
    make: (city, seedObj) => ({
      type: 'enterprise',
      customer: choice(['J.P. Morgan','Lockheed Martin','FedEx','State Farm','Bank of America'], seedObj),
      slaTier: choice(['silver','gold','platinum'], seedObj),
      issue: choice(['latency-spike','routing-anomaly','capacity-breach'], seedObj),
      latencyMs: randInt(80, 600, seedObj)
    })
  },
  {
    type: 'iot', weight: 5,
    make: (city, seedObj) => ({
      type: 'iot',
      deviceId: `SIM-${randInt(10000000, 99999999, seedObj)}`,
      issue: choice(['no-uplink','battery-low','temp-threshold'], seedObj),
      fleet: choice(['FedEx Fleet Sensors','UPS Telematics','USPS Trackers'], seedObj),
      region: nearestCityName(city)
    })
  },
  {
    type: 'satellite', weight: 3,
    make: (city, seedObj) => ({
      type: 'satellite',
      terminalId: `SAT-${randInt(1000, 9999, seedObj)}`,
      issue: choice(['signal-degradation','terminal-thermal','antenna-misalignment'], seedObj),
      snrDb: Number(randFloat(4.0, 18.0, seedObj).toFixed(1))
    })
  },
  {
    type: 'firstnet', weight: 4,
    make: (city, seedObj) => ({
      type: 'firstnet',
      agency: choice(['Dallas Fire Department','Plano PD','Austin EMS','Houston PD','San Antonio Fire'], seedObj),
      issue: choice(['coverage-gap','priority-preemption','device-auth'], seedObj),
      lat: city?.lat,
      lng: city?.lng
    })
  },
  {
    type: 'voip', weight: 4,
    make: (city, seedObj) => ({
      type: 'voip',
      accountId: `ATT-VOIP-${randInt(100, 999, seedObj)}`,
      issue: choice(['call-jitter','mos-drop','packet-reorder'], seedObj),
      jitterMs: randInt(20, 250, seedObj)
    })
  },
  {
    type: 'b2b-vpn', weight: 4,
    make: (city, seedObj) => ({
      type: 'b2b-vpn',
      customer: choice(['Lockheed Martin','Boeing','Raytheon','Chevron'], seedObj),
      issue: choice(['packet-loss','ike-rekey-fail','tunnel-down'], seedObj),
      lossPercent: Number(randFloat(0.5, 8.0, seedObj).toFixed(1)),
      tunnelId: `VPN-${cityShort(city)}-${String(randInt(1, 999, seedObj)).padStart(3,'0')}`
    })
  },
  {
    type: 'fiber-construction', weight: 3,
    make: (city, seedObj) => ({
      type: 'fiber-construction',
      projectId: `FBR-${cityShort(city).toUpperCase()}-${randInt(100, 999, seedObj)}`,
      issue: choice(['permit-delay','splice-crew-shortage','locate-miss'], seedObj),
      city: nearestCityName(city),
      contractor: choice(['Lumen Builders','Henkels & McCoy','MasTec','Dycom'], seedObj)
    })
  },
  {
    type: 'backhaul', weight: 3,
    make: (city, seedObj) => ({
      type: 'backhaul',
      linkId: `BH-${cityShort(city).toUpperCase()}-${randInt(100, 999, seedObj)}`,
      issue: choice(['capacity-exceeded','fec-errors','fiber-impairment'], seedObj),
      utilizationPct: Number(randFloat(70, 99.9, seedObj).toFixed(1))
    })
  },
  {
    type: 'datacenter', weight: 2,
    make: (city, seedObj) => ({
      type: 'datacenter',
      facilityId: choice(['ATTDAL01','ATTAUS01','ATTSAT01','ATTDFW02'], seedObj),
      issue: choice(['cooling-alert','power-redundancy','fire-suppression-armed'], seedObj),
      temperatureC: Number(randFloat(27.0, 42.0, seedObj).toFixed(1))
    })
  },
  {
    type: 'edge-compute', weight: 2,
    make: (city, seedObj) => ({
      type: 'edge-compute',
      nodeId: `EDGE-${cityShort(city).toUpperCase()}-${String(randInt(1, 999, seedObj)).padStart(3,'0')}`,
      issue: choice(['cpu-overload','container-crash-loop','disk-iops-high'], seedObj),
      cpuUtilization: randInt(70, 99, seedObj)
    })
  },
  {
    type: 'public-safety', weight: 2,
    make: (city, seedObj) => ({
      type: 'public-safety',
      agency: choice(['Plano PD','Austin PD','Fort Worth Fire','Dallas EMS'], seedObj),
      issue: choice(['dispatch-app-error','mdt-offline','cad-sync-delay'], seedObj),
      incidentId: `INC-${new Date().getUTCFullYear()}-${randInt(1000, 9999, seedObj)}`
    })
  },
  {
    type: 'smart-city', weight: 2,
    make: (city, seedObj) => ({
      type: 'smart-city',
      sensorId: `CAM-${cityShort(city).toUpperCase()}-${randInt(100, 999, seedObj)}`,
      issue: choice(['connectivity-loss','firmware-stale','power-cycling'], seedObj),
      location: choice(['Main & 15th St','Elm & 2nd Ave','Market & 7th'], seedObj)
    })
  },
  {
    type: 'government', weight: 1,
    make: (city, seedObj) => ({
      type: 'government',
      department: choice(['FAA Communications','USPS IT','FEMA Region 6','TXDOT'], seedObj),
      issue: choice(['redundancy-failover','encryption-mismatch','route-leak'], seedObj),
      region: choice(['Southwest Ops','Gulf Coast','Central Plains'], seedObj)
    })
  },
  {
    type: 'cloud-network', weight: 2,
    make: (city, seedObj) => ({
      type: 'cloud-network',
      customer: choice(['AWS Direct Connect','Azure ExpressRoute','Google Cloud Interconnect'], seedObj),
      issue: choice(['route-flap','bgp-hold-timer','mtu-mismatch'], seedObj),
      bgpPeer: `${randInt(10,10,seedObj)}.${randInt(10,250,seedObj)}.${randInt(0,250,seedObj)}.${randInt(1,254,seedObj)}`
    })
  }
];

const ISSUE_TOTAL_WEIGHT = ISSUE_FACTORIES.reduce((s,f)=>s+f.weight,0);
function pickIssueFactory(seedObj) {
  let r = (rand(seedObj) || Math.random()) * ISSUE_TOTAL_WEIGHT;
  for (const f of ISSUE_FACTORIES) {
    r -= f.weight;
    if (r <= 0) return f;
  }
  return ISSUE_FACTORIES[ISSUE_FACTORIES.length - 1];
}

// ---- Simulation State ----
let SIM = {
  running: false,
  eventsPerSec: 5000,
  batchSize: 1000,
  spread: 2.0,
  seed: null,
  concurrency: 1,
  timer: null
};

function serializeSim() {
  const { timer, ...rest } = SIM;
  return rest;
}

function makeEvent(baseCity, jittered, seedObj) {
  const ts = new Date();
  const factory = pickIssueFactory(seedObj);
  const serviceIssue = factory.make(baseCity, seedObj);

  return {
    ts,
    city: baseCity.name,
    base: {
      lat: baseCity.lat,
      lng: baseCity.lng,
      sigmaKm: baseCity.sigmaKm ?? 10,
      weight: baseCity.weight ?? 1
    },
    loc: { type: 'Point', coordinates: [jittered.lng, jittered.lat] },
    lat: jittered.lat,
    lng: jittered.lng,
    source: 'sim',
    rgn: baseCity.rgn || null,
    weight: 1,
    serviceIssue // NEW polymorphic subdocument
  };
}

async function tick(epsForThisWorker) {
  const { batchSize, spread, seed } = SIM;
  const seedObj = seed != null ? { value: seed >>> 0 } : null;
  const batches = Math.max(1, Math.ceil(epsForThisWorker / batchSize));
  const effectiveBatch = Math.max(1, Math.floor(epsForThisWorker / batches));

  for (let b = 0; b < batches; b++) {
    const docs = new Array(effectiveBatch);
    for (let i = 0; i < effectiveBatch; i++) {
      const base = pickWeightedCity(seedObj);
      const p = sampleAround(base, spread, seedObj);
      docs[i] = makeEvent(base, p, seedObj);
    }
    coll.insertMany(docs, { ordered: false })
      .then(res => { STATS.lastSecondInserts += (res?.insertedCount || docs.length); })
      .catch(() => {});
  }
}

// ---- API ----
app.get('/health', (req, res) => res.json({ ok: true, running: SIM.running }));

app.post('/start', async (req, res) => {
  const { eventsPerSec, batchSize, spread, seed, concurrency } = req.body || {};
  if (eventsPerSec)  SIM.eventsPerSec = Math.max(1, Number(eventsPerSec));
  if (batchSize)     SIM.batchSize    = Math.max(1, Number(batchSize));
  if (spread != null)SIM.spread       = Math.max(0.1, Number(spread));
  if (concurrency)   SIM.concurrency  = Math.max(1, Math.floor(Number(concurrency)));
  SIM.seed = (seed === null || seed === undefined || seed === '') ? null : Number(seed);

  if (SIM.running && SIM.timer) clearInterval(SIM.timer);

  const base = Math.floor(SIM.eventsPerSec / SIM.concurrency);
  const extra = SIM.eventsPerSec % SIM.concurrency;

  SIM.timer = setInterval(() => {
    for (let w = 0; w < SIM.concurrency; w++) {
      const epsForThisWorker = base + (w < extra ? 1 : 0);
      if (epsForThisWorker > 0) tick(epsForThisWorker);
    }
    STATS.history.push(STATS.lastSecondInserts);
    if (STATS.history.length > STATS.maWindow) STATS.history.shift();
    STATS.lastSecondInserts = 0;
  }, 1000);

  SIM.running = true;
  res.json({
    running: true,
    ...serializeSim(),
    cityModelSize: CITY_MODEL.length,
    insertsPerSecMA: movingAverage(),
    insertsPerSecWindow: STATS.maWindow
  });
});

app.post('/stop', async (req, res) => {
  if (SIM.timer) clearInterval(SIM.timer);
  SIM.timer = null;
  SIM.running = false;
  res.json({
    running: false,
    ...serializeSim(),
    cityModelSize: CITY_MODEL.length,
    insertsPerSecMA: movingAverage(),
    insertsPerSecWindow: STATS.maWindow
  });
});

app.get('/status', (req, res) => {
  res.json({
    running: SIM.running,
    ...serializeSim(),
    cityModelSize: CITY_MODEL.length,
    insertsPerSecMA: movingAverage(),
    insertsPerSecWindow: STATS.maWindow
  });
});

app.listen(PORT, () => {
  console.log(`Simulator server listening on http://localhost:${PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  if (SIM.timer) clearInterval(SIM.timer);
  client.close().catch(() => {}).finally(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
