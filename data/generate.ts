import { writeFileSync, mkdirSync } from "node:fs";
import { TYPE_SPECS, ALL_TYPES, type ServiceType, type Severity } from "./types.ts";
import { MEDIA_SPECS, MEDIA_POOL, type PoolAsset, type MediaKind } from "./media.ts";

// ---------------------------------------------------------------------------
// Deterministic PRNG — same seed always yields the same corpus.
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = mulberry32(20260812);
const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
const rint = (lo: number, hi: number) => Math.floor(r() * (hi - lo + 1)) + lo;
const rfloat = (lo: number, hi: number, dp = 3) => Number((r() * (hi - lo) + lo).toFixed(dp));

// ---------------------------------------------------------------------------
// Canonical constants
// ---------------------------------------------------------------------------
const QUERY = "backhoe damage near SE-MCA-2211";
const TARGET_ENCLOSURE = "SE-MCA-2211";
const CORPUS_TOTAL = 323;

const COUNTS = { lexicalOnly: 3, both: 4, semanticOnly: 15 } as const;
const LEXICAL_TOTAL = COUNTS.lexicalOnly + COUNTS.both;   // 7
const SEMANTIC_TOTAL = COUNTS.semanticOnly + COUNTS.both; // 19
const HYBRID_TOTAL = COUNTS.lexicalOnly + COUNTS.semanticOnly + COUNTS.both; // 22
const NOT_MATCHED = CORPUS_TOTAL - HYBRID_TOTAL;          // 301

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------
const CITIES: [string, string, number, number][] = [
  ["Warrior","AL",33.8143,-86.8094],["McArthur","OH",39.2453,-82.4796],
  ["Terry","MS",32.0949,-90.2942],["Perham","MN",46.5941,-95.5723],
  ["Swifton","AR",35.8231,-91.1240],["Loco Hills","NM",32.8262,-103.9269],
  ["Lewisville","GA",33.9540,-84.1996],["Myrtle Beach","SC",33.6891,-78.8867],
  ["Plano","TX",33.0198,-96.6989],["Denver","CO",39.7392,-104.9903],
  ["Chicago","IL",41.8781,-87.6298],["Portland","OR",45.5152,-122.6784],
  ["Austin","TX",30.2672,-97.7431],["Los Angeles","CA",34.0522,-118.2437],
  ["Birmingham","AL",33.5186,-86.8104],["Gadsden","AL",34.0143,-86.0066],
  ["Cullman","AL",34.1748,-86.8436],["Jasper","AL",33.8312,-87.2772],
  ["Atlanta","GA",33.7490,-84.3880],["Nashville","TN",36.1627,-86.7816],
  ["Memphis","TN",35.1495,-90.0490],["Little Rock","AR",34.7465,-92.2896],
  ["Jackson","MS",32.2988,-90.1848],["Mobile","AL",30.6954,-88.0399],
  ["Tampa","FL",27.9506,-82.4572],["Orlando","FL",28.5383,-81.3792],
  ["Charlotte","NC",35.2271,-80.8431],["Raleigh","NC",35.7796,-78.6382],
  ["Columbia","SC",34.0007,-81.0348],["Savannah","GA",32.0809,-81.0912],
  ["Louisville","KY",38.2527,-85.7585],["Cincinnati","OH",39.1031,-84.5120],
  ["Columbus","OH",39.9612,-82.9988],["Cleveland","OH",41.4993,-81.6944],
  ["Detroit","MI",42.3314,-83.0458],["Indianapolis","IN",39.7684,-86.1581],
  ["St. Louis","MO",38.6270,-90.1994],["Kansas City","MO",39.0997,-94.5786],
  ["Omaha","NE",41.2565,-95.9345],["Des Moines","IA",41.5868,-93.6250],
  ["Minneapolis","MN",44.9778,-93.2650],["Milwaukee","WI",43.0389,-87.9065],
  ["Oklahoma City","OK",35.4676,-97.5164],["Tulsa","OK",36.1540,-95.9928],
  ["Dallas","TX",32.7767,-96.7970],["Houston","TX",29.7604,-95.3698],
  ["San Antonio","TX",29.4241,-98.4936],["El Paso","TX",31.7619,-106.4850],
  ["Phoenix","AZ",33.4484,-112.0740],["Tucson","AZ",32.2226,-110.9747],
  ["Albuquerque","NM",35.0844,-106.6504],["Las Vegas","NV",36.1699,-115.1398],
  ["Salt Lake City","UT",40.7608,-111.8910],["Boise","ID",43.6150,-116.2023],
  ["Seattle","WA",47.6062,-122.3321],["Spokane","WA",47.6588,-117.4260],
  ["Sacramento","CA",38.5816,-121.4944],["San Diego","CA",32.7157,-117.1611],
  ["Fresno","CA",36.7378,-119.7871],["Reno","NV",39.5296,-119.8138],
  ["Billings","MT",45.7833,-108.5007],["Cheyenne","WY",41.1400,-104.8202],
  ["Sioux Falls","SD",43.5460,-96.7313],["Fargo","ND",46.8772,-96.7898],
  ["Wichita","KS",37.6872,-97.3301],["Springfield","IL",39.7817,-89.6501],
  ["Lexington","KY",38.0406,-84.5037],["Knoxville","TN",35.9606,-83.9207],
  ["Roanoke","VA",37.2710,-79.9414],["Richmond","VA",37.5407,-77.4360],
  ["Baltimore","MD",39.2904,-76.6122],["Philadelphia","PA",39.9526,-75.1652],
  ["Pittsburgh","PA",40.4406,-79.9959],["Buffalo","NY",42.8864,-78.8784],
  ["Albany","NY",42.6526,-73.7562],["Hartford","CT",41.7658,-72.6734],
  ["Providence","RI",41.8240,-71.4128],["Portland","ME",43.6591,-70.2568],
  ["Manchester","NH",42.9956,-71.4548],["Burlington","VT",44.4759,-73.2121],
];

// ---------------------------------------------------------------------------
// Corpus construction
// ---------------------------------------------------------------------------
type Bucket = "lexicalOnly" | "both" | "semanticOnly" | "notMatched";

interface Row {
  ticketRef: string;
  objectId: string;
  type: ServiceType;
  bucket: Bucket;
  city: string; state: string; lat: number; lng: number;
  ts: string;
  clusterId: string | null;
  isSeed?: boolean;
  novelty: number | null;
}

const plan: Row[] = [];
let oidCounter = 0x8000;
const nextOid = () => `6a7be1f056d4eaa839dc${(oidCounter++).toString(16)}`;

const jitter = (v: number, km: number) => v + (r() - 0.5) * (km / 111);
const baseTs = Date.parse("2026-08-12T03:01:04.778Z");

// ── The Warrior cluster: 6 members, all semanticOnly (they describe the
//    excavation cascade without ever naming SE-MCA-2211).
const CLUSTER_ID = "CLUSTER-2026-0812-004";
const CLUSTER_PLAN: [string, ServiceType, number][] = [
  ["INC-2026-9101", "construction", 0],
  ["INC-2026-9104", "fiber", 2],
  ["INC-2026-9107", "backhaul", 4],
  ["INC-2026-9112", "smartcell", 6],
  ["INC-2026-9118", "broadband", 9],
  ["INC-2026-9123", "voip", 11],
];
// The six cluster members tell one specific story: a directional bore strike
// on the SE-WAR ring segment cascading through four service types in 11 minutes.
// Their narratives are scripted, not generated, because mock-clusters.json quotes
// them as evidence and the text has to match the claim.
const CLUSTER_NARRATIVE: Record<string, string> = {
  "INC-2026-9101":
    "Directional bore contacted unmarked conduit at 4ft depth on the SE-WAR ring segment. Contractor crew stopped work immediately on detecting resistance. Adjacent splice enclosure SE-WAR-1104 may be compromised. 1400 planned passings at risk.",
  "INC-2026-9104":
    "Optical power collapsed on PON 1/3/4 off OLT-WAR-07. Reading -31.4dBm against -19.0 nominal. OTDR places the event at 1840m, just past the SE-WAR-1104 enclosure. 340 subscribers dark. Third-party excavation suspected based on timing.",
  "INC-2026-9107":
    "BH-WAR-118 errored seconds spiking, path unprotected. Utilization dropped to zero on the fiber leg at 03:05Z. 6 sites behind this link have lost transport. Correlates with ground work reported on the SE-WAR route.",
  "INC-2026-9112":
    "SC-WAR-203 stopped reporting, no heartbeat since 03:07Z. StreetMacro SM-200 on a pole mount, backhaul BH-WAR-118. 3 sectors down, roughly 480 subscribers losing offload.",
  "INC-2026-9118":
    "Subscribers on NODE-WAR-012 report the internet just quit with no lights on the ONT. 890 subs share the segment. No modem-side fault; upstream plant suspected.",
  "INC-2026-9123":
    "Dead air on all inbound calls to the Warrior office. 62 extensions affected through SBC-RDG-02. MOS 1.8, PBX side reports no faults. Trunk path traverses the SE-WAR segment.",
};

const CLUSTER_FIELDS: Record<string, Record<string, unknown>> = {
  "INC-2026-9101": {
    projectCode: "FBR-WAR-311", crewCode: "CRW-4213", contractor: "Cardinal Builders",
    phase: "boring", permitAuthority: "Blount County ROW",
    blockedFootageM: 620, boreType: "directional", crewIdleDays: 0,
    adjacentAssets: ["SE-WAR-1104"],
  },
  "INC-2026-9104": {
    accountId: "FBR-262", oltId: "OLT-WAR-07", ponPort: "1/3/4",
    opticalPowerDbm: -31.4, expectedPowerDbm: -19.0,
    spliceEnclosureId: "SE-WAR-1104", otdrDistanceM: 1840,
    suspectedCause: "third-party-dig",
  },
  "INC-2026-9107": {
    linkCode: "BH-WAR-118", mediaType: "fiber", capacityGbps: 10,
    pathLengthKm: 12.4, erroredSeconds: 1840, protectionState: "unprotected",
    rslDbm: -74, utilizationPct: 0,
  },
  "INC-2026-9112": {
    nodeId: "SC-WAR-203", vendor: "StreetMacro SM-200", mountType: "pole",
    poleOwner: "Valley Electric", powerFeed: "metered", sectorCount: 3,
    backhaulLinkCode: "BH-WAR-118", coverageAreaKm2: 0.4,
  },
  "INC-2026-9118": {
    accountId: "BB-515", modemModel: "RG-320", nodeId: "NODE-WAR-012",
    snrDb: 22.1, downstreamMbps: 0, expectedMbps: 1000, plantSegment: "SEG-12",
  },
  "INC-2026-9123": {
    accountId: "VOIP-194", pbxVendor: "UCM-9000", codec: "G.711",
    mosScore: 1.8, jitterMs: 178, sbcNode: "SBC-RDG-02",
  },
};

const CLUSTER_IMPACT: Record<string, number> = {
  "INC-2026-9101": 1400, "INC-2026-9104": 340, "INC-2026-9107": 6,
  "INC-2026-9112": 480, "INC-2026-9118": 890, "INC-2026-9123": 62,
};

CLUSTER_PLAN.forEach(([ticketRef, type, offsetMin], i) => {
  plan.push({
    ticketRef, objectId: nextOid(), type, bucket: "semanticOnly",
    city: "Warrior", state: "AL",
    lat: jitter(33.8143, 6), lng: jitter(-86.8094, 6),
    ts: new Date(baseTs + offsetMin * 60_000).toISOString(),
    clusterId: CLUSTER_ID, isSeed: i === 0, novelty: null,
  });
});

// ── The control case: geographically near the cluster, semantically distant.
plan.push({
  ticketRef: "INC-2026-9130", objectId: nextOid(), type: "datacenter",
  bucket: "notMatched", city: "Warrior", state: "AL",
  lat: jitter(33.8143, 8), lng: jitter(-86.8094, 8),
  ts: new Date(baseTs + 7 * 60_000).toISOString(),
  clusterId: null, novelty: null,
});

// ── BOTH: contain SE-MCA-2211 literally AND describe excavation damage.
const BOTH_PLAN: [string, ServiceType, number][] = [
  ["INC-2026-8841", "fiber", 1],
  ["INC-2026-8845", "construction", 6],
  ["INC-2026-8848", "backhaul", 14],
  ["INC-2026-8852", "smartcell", 15],
];
BOTH_PLAN.forEach(([ticketRef, type, cityIdx]) => {
  const [city, state, lat, lng] = CITIES[cityIdx];
  plan.push({
    ticketRef, objectId: nextOid(), type, bucket: "both",
    city, state, lat: jitter(lat, 12), lng: jitter(lng, 12),
    ts: new Date(baseTs - rint(60, 5000) * 60_000).toISOString(),
    clusterId: null, novelty: null,
  });
});

// ── LEXICAL ONLY: name SE-MCA-2211 but are about something else entirely.
//    These are the documents vector search cannot reach — the case FOR hybrid.
const LEXICAL_ONLY_PLAN: [string, ServiceType, number][] = [
  ["INC-2026-8860", "datacenter", 32],
  ["INC-2026-8863", "government", 30],
  ["INC-2026-8866", "edge", 10],
];
LEXICAL_ONLY_PLAN.forEach(([ticketRef, type, cityIdx]) => {
  const [city, state, lat, lng] = CITIES[cityIdx];
  plan.push({
    ticketRef, objectId: nextOid(), type, bucket: "lexicalOnly",
    city, state, lat: jitter(lat, 12), lng: jitter(lng, 12),
    ts: new Date(baseTs - rint(200, 9000) * 60_000).toISOString(),
    clusterId: null, novelty: null,
  });
});

// ── SEMANTIC ONLY: 9 more beyond the 6 cluster members.
const SEM_ONLY_PLAN: [string, ServiceType, number][] = [
  ["INC-2026-8712", "construction", 6],
  ["INC-2026-8455", "fiber", 5],
  ["INC-2026-8203", "fiber", 2],
  ["INC-2026-7991", "backhaul", 4],
  ["INC-2026-7744", "fiber", 3],
  ["INC-2026-8301", "smartcell", 17],
  ["INC-2026-8305", "broadband", 16],
  ["INC-2026-8309", "construction", 15],
  ["INC-2026-8312", "smart-city", 18],
];
SEM_ONLY_PLAN.forEach(([ticketRef, type, cityIdx]) => {
  const [city, state, lat, lng] = CITIES[cityIdx];
  plan.push({
    ticketRef, objectId: nextOid(), type, bucket: "semanticOnly",
    city, state, lat: jitter(lat, 14), lng: jitter(lng, 14),
    ts: new Date(baseTs - rint(30, 7000) * 60_000).toISOString(),
    clusterId: null, novelty: null,
  });
});

// ── One novel incident (high novelty, unmatched) for the Live Feeds panel.
plan.push({
  ticketRef: "INC-2026-8903", objectId: nextOid(), type: "satellite",
  bucket: "notMatched", city: "Myrtle Beach", state: "SC",
  lat: jitter(33.6891, 10), lng: jitter(-78.8867, 10),
  ts: new Date(baseTs - 40 * 60_000).toISOString(),
  clusterId: null, novelty: 0.87,
});

// ── Fill out the corpus so every one of the 20 types is well represented.
const already = plan.length;
const remaining = CORPUS_TOTAL - already;
// Round-robin across all types so nothing is missing, then random top-up.
let ticketSeq = 1000;
for (let i = 0; i < remaining; i++) {
  const type = i < ALL_TYPES.length * 2
    ? ALL_TYPES[i % ALL_TYPES.length]           // guarantee 2 of each first
    : pick(ALL_TYPES);
  const [city, state, lat, lng] = pick(CITIES);
  plan.push({
    ticketRef: `INC-2026-${ticketSeq++}`,
    objectId: nextOid(), type, bucket: "notMatched",
    city, state, lat: jitter(lat, 20), lng: jitter(lng, 20),
    ts: new Date(baseTs - rint(60, 60 * 24 * 30) * 60_000).toISOString(),
    clusterId: null,
    novelty: r() < 0.02 ? rfloat(0.72, 0.9, 2) : null,
  });
}

// ---------------------------------------------------------------------------
// Narrative generation with weighted phrasing
// ---------------------------------------------------------------------------
const SEVERITY_BY_WEIGHT: [Severity, number, number][] = [
  ["p1", 5, 10], ["p2", 4, 10], ["p3", 2, 5], ["p4", 1, 5],
];

/** Caps any single phrasing near 20% per type; "backhoe" near 8% for fiber. */
function choosePhrasing(type: ServiceType, bucket: Bucket, used: Map<string, number>, total: number) {
  const pool = TYPE_SPECS[type].phrasings;
  const cap = Math.max(1, Math.ceil(total * 0.2));
  const backhoeCap = Math.max(1, Math.ceil(total * 0.08));
  const candidates = pool.filter((p) => {
    const n = used.get(p) ?? 0;
    const isBackhoe = /backhoe/i.test(p);
    return n < (isBackhoe ? backhoeCap : cap);
  });
  const chosen = (candidates.length ? candidates : pool)[
    Math.floor(r() * (candidates.length || pool.length))
  ];
  used.set(chosen, (used.get(chosen) ?? 0) + 1);
  return chosen;
}

const phrasingUse = new Map<ServiceType, Map<string, number>>();
const typeTotals = new Map<ServiceType, number>();
plan.forEach((p) => typeTotals.set(p.type, (typeTotals.get(p.type) ?? 0) + 1));

const incidents = plan.map((p) => {
  const spec = TYPE_SPECS[p.type];
  if (!phrasingUse.has(p.type)) phrasingUse.set(p.type, new Map());
  const phrasing = choosePhrasing(p.type, p.bucket, phrasingUse.get(p.type)!, typeTotals.get(p.type)!);

  const scriptedFields = CLUSTER_FIELDS[p.ticketRef];
  const fields = scriptedFields
    ? { ...spec.fields(r, pick), ...scriptedFields }
    : spec.fields(r, pick);
  const impactCount = CLUSTER_IMPACT[p.ticketRef] ?? rint(spec.impactRange[0], spec.impactRange[1]);

  // Documents in LEXICAL_ONLY or BOTH must literally contain the enclosure ID.
  if (p.bucket === "both" || p.bucket === "lexicalOnly") {
    if ("spliceEnclosureId" in fields) fields.spliceEnclosureId = TARGET_ENCLOSURE;
    if ("adjacentAssets" in fields) fields.adjacentAssets = [TARGET_ENCLOSURE];
  }

  let narrative = CLUSTER_NARRATIVE[p.ticketRef] ?? spec.template(fields, phrasing, impactCount);

  if (p.bucket === "both" && !narrative.includes(TARGET_ENCLOSURE)) {
    narrative += ` Damage traced to the ${TARGET_ENCLOSURE} enclosure route.`;
  }
  if (p.bucket === "lexicalOnly") {
    // Names the enclosure in a context unrelated to excavation damage.
    narrative += ` ${pick([
      `Asset register lists ${TARGET_ENCLOSURE} as the nearest passive plant record; no physical impact.`,
      `Change ticket references ${TARGET_ENCLOSURE} for scheduled audit only; unrelated to this fault.`,
      `Inventory reconciliation flagged ${TARGET_ENCLOSURE} in the same billing group; informational.`,
    ])}`;
  }

  const inCluster = Boolean(p.clusterId);
  const [severity, weight, sigmaKm] = inCluster
    ? SEVERITY_BY_WEIGHT[0]
    : p.bucket === "notMatched" && r() < 0.5
      ? SEVERITY_BY_WEIGHT[rint(2, 3)]
      : SEVERITY_BY_WEIGHT[rint(0, 1)];

  const resolved = inCluster ? false : r() < 0.55;

  return {
    _id: p.objectId,
    type: "incident" as const,
    ts: p.ts,
    loc: { type: "Point" as const, coordinates: [Number(p.lng.toFixed(5)), Number(p.lat.toFixed(5))] },
    city: p.city,
    state: p.state,
    lat: Number(p.lat.toFixed(5)),
    lng: Number(p.lng.toFixed(5)),
    weight,
    sigmaKm,
    simRunId: "20260812-0300Z-fixture-v4",
    serviceIssue: {
      type: p.type,
      category: spec.category,
      issue: spec.issue,
      ticketRef: p.ticketRef,
      narrative,
      symptoms: spec.symptoms,
      severity,
      reportedBy: pick(["customer", "alarm", "field-tech", "proactive"]),
      impact: {
        unit: spec.impactUnit,
        count: impactCount,
        scope: pick(["single", "segment", "metro", "region"]),
      },
      ...fields,
      resolution: {
        state: resolved ? "resolved" : "open",
        rootCause: resolved ? (spec.digRelated ? "third-party-dig" : "equipment-fault") : null,
        hours: resolved ? rfloat(1.2, 9.5, 1) : null,
        crew: spec.crew,
        techs: rint(1, 4),
        truckRolls: rint(0, 2),
        parts: spec.parts,
        costUsd: resolved ? Math.round(spec.costBase * (0.7 + r() * 0.8)) : null,
        resolvedAt: resolved ? new Date(Date.parse(p.ts) + rint(60, 700) * 60_000).toISOString() : null,
      },
    },
    correlation: {
      clusterId: p.clusterId,
      isSystemic: Boolean(p.clusterId),
      isSeed: p.isSeed ?? false,
      novelty: p.novelty,
    },
  };
});

// ---------------------------------------------------------------------------
// Media — one document per artifact, separate collection, joined on ticketRef.
// Assets are reused from the pool; the caption carries incident specificity.
// ---------------------------------------------------------------------------

const S3_BUCKET = "incident-intelligence-media";

const fillCaption = (tpl: string, si: Record<string, any>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = si[k];
    return v === undefined || v === null ? k : String(v);
  });

const mediaDocs: any[] = [];
let mediaSeq = 0;

incidents.forEach((inc) => {
  const si: any = inc.serviceIssue;
  const spec = MEDIA_SPECS[si.type as ServiceType];
  if (r() > spec.probability) return;

  const want = rint(spec.countRange[0], spec.countRange[1]);
  const candidates = MEDIA_POOL.filter(
    (a) => a.applicableTypes.includes(si.type) && spec.kinds.includes(a.kind)
  );
  if (!candidates.length) return;

  // Prefer kind variety within one incident.
  const chosen: PoolAsset[] = [];
  const kindsUsed = new Set<MediaKind>();
  for (const pref of spec.kinds) {
    if (chosen.length >= want) break;
    const pool = candidates.filter((a) => a.kind === pref && !chosen.includes(a));
    if (pool.length && !kindsUsed.has(pref)) {
      chosen.push(pool[Math.floor(r() * pool.length)]);
      kindsUsed.add(pref);
    }
  }
  while (chosen.length < want) {
    const rest = candidates.filter((a) => !chosen.includes(a));
    if (!rest.length) break;
    chosen.push(rest[Math.floor(r() * rest.length)]);
  }

  chosen.forEach((asset) => {
    const tpls = spec.captions[asset.kind] ?? [];
    const caption = tpls.length
      ? fillCaption(tpls[Math.floor(r() * tpls.length)], si)
      : `${asset.kind} artifact for ${si.ticketRef}`;

    mediaDocs.push({
      _id: `6b1c${(0x9000 + mediaSeq).toString(16)}${String(mediaSeq).padStart(6, "0")}`,
      mediaId: `MED-${si.ticketRef.replace("INC-2026-", "")}-${String(++mediaSeq).padStart(3, "0")}`,
      ticketRef: si.ticketRef,
      simRunId: inc.simRunId,

      // denormalised from parent so media search can prefilter
      serviceType: si.type,
      category: si.category,
      city: inc.city,
      state: inc.state,
      lat: inc.lat,
      lng: inc.lng,
      ts: inc.ts,

      kind: asset.kind,
      poolId: asset.poolId,
      mimeType: asset.mimeType,
      uri: `s3://${S3_BUCKET}/${asset.key}`,
      pageNumber: asset.pageNumber ?? null,
      video: asset.video
        ? { ...asset.video, thumbnailUri: `s3://${S3_BUCKET}/${asset.video.thumbnailKey}` }
        : null,
      capturedAt: new Date(Date.parse(inc.ts) + rint(5, 240) * 60_000).toISOString(),
      capturedBy: asset.kind === "video-segment" ? "drone"
                : asset.kind === "image" ? pick(["field-tech", "drone", "customer"])
                : "system",

      caption,
      extractedText: asset.kind === "table" || asset.kind === "text" ? caption : null,

      // pipeline-authored, null on insert — same separation as the narrative
      embedding: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Search result sets — derived from bucket membership, never hand-written.
// ---------------------------------------------------------------------------
const byBucket = (b: Bucket) => plan.filter((p) => p.bucket === b).map((p) => p.ticketRef);

const LEXICAL_ONLY = byBucket("lexicalOnly");
const BOTH = byBucket("both");
const SEMANTIC_ONLY = byBucket("semanticOnly");

const LEXICAL_SET = [...LEXICAL_ONLY, ...BOTH];
const SEMANTIC_SET = [...SEMANTIC_ONLY, ...BOTH];
const HYBRID_SET = [...LEXICAL_ONLY, ...SEMANTIC_ONLY, ...BOTH];

// Per-pipeline scores. Documents in BOTH score high on both pipelines.
const lexicalScore = new Map<string, number>();
const vectorScore = new Map<string, number>();

BOTH.forEach((t, i) => {
  lexicalScore.set(t, Number((0.94 - i * 0.03).toFixed(3)));
  vectorScore.set(t, Number((0.89 - i * 0.02).toFixed(3)));
});
LEXICAL_ONLY.forEach((t, i) => {
  lexicalScore.set(t, Number((0.88 - i * 0.04).toFixed(3)));
});
SEMANTIC_ONLY.forEach((t, i) => {
  vectorScore.set(t, Number((0.905 - i * 0.011).toFixed(3)));
});

const rankOf = (m: Map<string, number>) => {
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  return new Map(sorted.map(([t], i) => [t, i + 1]));
};
const lexicalRank = rankOf(lexicalScore);
const vectorRank = rankOf(vectorScore);

// Reciprocal rank fusion, weighted.
const K = 60;
const W = { lexical: 0.38, semantic: 0.62 };
const fusedRaw = new Map<string, number>();
HYBRID_SET.forEach((t) => {
  const lr = lexicalRank.get(t);
  const vr = vectorRank.get(t);
  const s = (lr ? W.lexical / (K + lr) : 0) + (vr ? W.semantic / (K + vr) : 0);
  fusedRaw.set(t, s);
});
const maxFused = Math.max(...fusedRaw.values());
const fusedScore = new Map(
  [...fusedRaw].map(([t, s]) => [t, Number((0.55 + 0.42 * (s / maxFused)).toFixed(3))])
);
const fusedRank = rankOf(fusedScore);

const provenanceOf = (t: string) =>
  BOTH.includes(t) ? "bothPipelines"
  : LEXICAL_ONLY.includes(t) ? "lexicalOnly"
  : SEMANTIC_ONLY.includes(t) ? "semanticOnly"
  : "notMatched";

const orderedHybrid = [...HYBRID_SET].sort(
  (a, b) => (fusedScore.get(b) ?? 0) - (fusedScore.get(a) ?? 0)
);
const orderedLexical = [...LEXICAL_SET].sort(
  (a, b) => (lexicalScore.get(b) ?? 0) - (lexicalScore.get(a) ?? 0)
);
const orderedSemantic = [...SEMANTIC_SET].sort(
  (a, b) => (vectorScore.get(b) ?? 0) - (vectorScore.get(a) ?? 0)
);

const resultRecord = (t: string) => ({
  ticketRef: t,
  provenance: provenanceOf(t),
  lexicalRank: lexicalRank.get(t) ?? null,
  lexicalScore: lexicalScore.get(t) ?? null,
  vectorRank: vectorRank.get(t) ?? null,
  vectorScore: vectorScore.get(t) ?? null,
  fusedRank: fusedRank.get(t) ?? null,
  fusedScore: fusedScore.get(t) ?? null,
});

const searchResults = {
  query: QUERY,
  embeddingModel: "voyage-4",
  corpusTotal: CORPUS_TOTAL,
  counts: {
    lexicalTotal: LEXICAL_SET.length,
    semanticTotal: SEMANTIC_SET.length,
    hybridTotal: HYBRID_SET.length,
    lexicalOnly: LEXICAL_ONLY.length,
    semanticOnly: SEMANTIC_ONLY.length,
    bothPipelines: BOTH.length,
    notMatched: CORPUS_TOTAL - HYBRID_SET.length,
    recallLiftPct: Math.round(
      ((HYBRID_SET.length - LEXICAL_SET.length) / LEXICAL_SET.length) * 100
    ),
  },
  modes: {
    lexical: {
      pipeline: {
        $search: { index: "inc_text", text: { query: QUERY, path: ["searchBlob"] } },
      },
      limit: 100,
      latencyMs: 12,
      indexes: 1,
      embedCalls: 0,
      results: orderedLexical.map(resultRecord),
    },
    semantic: {
      pipeline: {
        $vectorSearch: {
          index: "inc_vec", path: "embedding.vector",
          queryVector: "[…1024 floats]", numCandidates: 500, limit: 100,
        },
      },
      latencyMs: 48,
      indexes: 1,
      embedCalls: 1,
      results: orderedSemantic.map(resultRecord),
    },
    hybrid: {
      pipeline: {
        $rankFusion: {
          input: { pipelines: { lexical: "[…]", semantic: "[…]" } },
          combination: { weights: W },
          scoreDetails: true,
        },
      },
      weights: W,
      latencyMs: 61,
      indexes: 2,
      embedCalls: 1,
      results: orderedHybrid.map(resultRecord),
    },
  },
};

// ---------------------------------------------------------------------------
// Nearest neighbours — symmetric, keyed by ticketRef, every incident covered.
// ---------------------------------------------------------------------------
// Types are placed by semantic affinity, not evenly around a circle, so the
// projection reads as scattered clusters rather than a synthetic ring.
const AFFINITY_GROUP: Record<string, [number, number]> = {
  // physical plant / excavation cascade — tight, near the matched region
  fiber: [0.30, 0.34], construction: [0.35, 0.30], backhaul: [0.27, 0.28],
  smartcell: [0.33, 0.39], broadband: [0.24, 0.36], "smart-city": [0.38, 0.35],
  // voice / session
  voip: [0.55, 0.22], "5g": [0.62, 0.28], wireless: [0.58, 0.34],
  "wifi-hotspot": [0.66, 0.20],
  // enterprise transport
  b2b: [0.74, 0.52], enterprise: [0.80, 0.46], "cloud-network": [0.86, 0.58],
  // compute / facilities
  datacenter: [0.72, 0.78], edge: [0.80, 0.84], iot: [0.62, 0.88],
  satellite: [0.52, 0.80],
  // public sector
  "priority-access": [0.18, 0.72], government: [0.12, 0.62], "public-safety": [0.22, 0.84],
};
const umapCentroid: Record<ServiceType, [number, number]> = {} as any;
ALL_TYPES.forEach((t) => { umapCentroid[t] = AFFINITY_GROUP[t]; });

const umap: Record<string, { x: number; y: number }> = {};
plan.forEach((p) => {
  const matched = p.bucket !== "notMatched";
  const [cx, cy] = umapCentroid[p.type];
  // Matched documents drift toward a shared excavation-damage region, but keep
  // enough spread that individual points remain distinguishable.
  const tx = 0.31, ty = 0.33;
  const pull = matched ? 0.55 : 0.0;
  const spread = matched ? 0.045 : 0.075;
  const gx = (r() + r() + r() - 1.5) * spread * 2;
  const gy = (r() + r() + r() - 1.5) * spread * 2;
  const x = cx * (1 - pull) + tx * pull + gx;
  const y = cy * (1 - pull) + ty * pull + gy;
  umap[p.ticketRef] = {
    x: Number(Math.min(0.97, Math.max(0.03, x)).toFixed(4)),
    y: Number(Math.min(0.97, Math.max(0.03, y)).toFixed(4)),
  };
});

const dist = (a: string, b: string) => {
  const p = umap[a], q = umap[b];
  return Math.hypot(p.x - q.x, p.y - q.y);
};
const maxDist = Math.SQRT2;
const byRef = new Map(incidents.map((i) => [i.serviceIssue.ticketRef, i]));

const neighbours: Record<string, any[]> = {};
const maxSpan = Math.SQRT2;

plan.forEach((p) => {
  const spec = TYPE_SPECS[p.type];
  const scored = plan
    .filter((q) => q.ticketRef !== p.ticketRef)
    .map((q) => {
      const qs = TYPE_SPECS[q.type];
      const d = dist(p.ticketRef, q.ticketRef) / maxSpan;
      // Same type dominates, then same category, then dig-relatedness, then
      // embedding-space proximity. This is what makes the dispatch prediction
      // coherent — neighbours share a crew and a parts list.
      const affinity =
        (q.type === p.type ? 0.55 : 0) +
        (qs.category === spec.category ? 0.18 : 0) +
        (qs.digRelated === spec.digRelated ? 0.09 : 0) +
        (1 - d) * 0.18;
      return { q, affinity };
    })
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 8);

  // Map rank to a readable descending band rather than raw distance, which
  // collapses to ~0.99 for everything once points cluster.
  const top = 0.91, bottom = 0.68;
  neighbours[p.ticketRef] = scored.map(({ q }, i) => {
    const inc = byRef.get(q.ticketRef)!;
    const sim = top - (i / 7) * (top - bottom) + (r() - 0.5) * 0.012;
    return {
      ticketRef: q.ticketRef,
      type: q.type,
      category: TYPE_SPECS[q.type].category,
      city: `${q.city}, ${q.state}`,
      similarity: Number(sim.toFixed(2)),
      resolution: {
        hours: inc.serviceIssue.resolution.hours,
        crew: inc.serviceIssue.resolution.crew,
        techs: inc.serviceIssue.resolution.techs,
        parts: inc.serviceIssue.resolution.parts,
        costUsd: inc.serviceIssue.resolution.costUsd,
      },
    };
  });
});

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------
const clusterMembers = plan.filter((p) => p.clusterId === CLUSTER_ID);
const seedRef = clusterMembers.find((m) => m.isSeed)!.ticketRef;
const memberSims: Record<string, number> = {
  "INC-2026-9101": 1.0, "INC-2026-9104": 0.88, "INC-2026-9107": 0.86,
  "INC-2026-9112": 0.84, "INC-2026-9118": 0.83, "INC-2026-9123": 0.79,
};
const control = plan.find((p) => p.ticketRef === "INC-2026-9130")!;

const clusters = [{
  clusterId: CLUSTER_ID,
  seedTicketRef: seedRef,
  city: "Warrior",
  state: "AL",
  ringSegment: "SE-WAR-1104",
  members: clusterMembers.map((m) => ({
    ticketRef: m.ticketRef,
    type: m.type,
    category: TYPE_SPECS[m.type].category,
    isSeed: Boolean(m.isSeed),
    similarityToSeed: m.isSeed ? null : memberSims[m.ticketRef],
    tOffsetMin: Math.round((Date.parse(m.ts) - baseTs) / 60000),
    narrativeFragment: byRef.get(m.ticketRef)!.serviceIssue.narrative.split(".")[0] + ".",
  })),
  stats: {
    memberCount: clusterMembers.length,
    distinctTypes: new Set(clusterMembers.map((m) => m.type)).size,
    distinctCategories: new Set(clusterMembers.map((m) => TYPE_SPECS[m.type].category)).size,
    maxPairwiseKm: 8.2,
    spanMinutes: 11,
    tightestPair: 0.91,
    controlExcluded: 1,
  },
  controlCase: {
    ticketRef: control.ticketRef,
    type: control.type,
    category: TYPE_SPECS[control.type].category,
    similarityToSeed: 0.31,
    distanceKm: 4.1,
  },
  detection: {
    windowHours: 6,
    radiusKm: 50,
    minNeighbours: 5,
    similarityFloor: 0.82,
    scoredAt: "2026-08-12T03:01:15Z",
    actualSpanKm: 8.2,
  },
  impact: {
    ticketsCollapsed: { from: 6, to: 1 },
    truckRollsAvoided: 5,
    estSavedUsd: 19200,
    derivation: "5 x $3,840 median splice-crew roll",
  },
  inferredRootCause: {
    description: "Third-party directional bore strike",
    confidence: 0.86,
    seedTicketRef: seedRef,
    quote: "Directional bore contacted unmarked conduit",
    downstreamNote: "5 downstream incidents consistent with loss of the SE-WAR ring segment",
  },
}];

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
const OUT = "/mnt/user-data/outputs/fixtures";
mkdirSync(OUT, { recursive: true });
const write = (name: string, data: unknown) =>
  writeFileSync(`${OUT}/${name}`, JSON.stringify(data, null, 2) + "\n");

write("mock-incidents.json", incidents);
write("mock-search-results.json", searchResults);
write("mock-neighbours.json", neighbours);
write("mock-clusters.json", clusters);
write("mock-umap.json", umap);
write("mock-media.json", mediaDocs);
write("media-pool.json", MEDIA_POOL.map((a) => ({ ...a, uri: `s3://${S3_BUCKET}/${a.key}` })));

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------
const c = searchResults.counts;
const problems: string[] = [];
if (c.lexicalOnly + c.semanticOnly + c.bothPipelines !== c.hybridTotal)
  problems.push("union arithmetic does not close");
if (c.hybridTotal + c.notMatched !== CORPUS_TOTAL)
  problems.push("hybrid + notMatched != corpusTotal");
if (!LEXICAL_SET.every((t) => HYBRID_SET.includes(t)))
  problems.push("hybrid does not contain all lexical results");
if (!SEMANTIC_SET.every((t) => HYBRID_SET.includes(t)))
  problems.push("hybrid does not contain all semantic results");
if (c.lexicalOnly === 0)
  problems.push("no lexical-only results: hybrid has no advantage over semantic");
if (incidents.length !== CORPUS_TOTAL)
  problems.push(`corpus size ${incidents.length} != ${CORPUS_TOTAL}`);
const refs = new Set(incidents.map((i) => i.serviceIssue.ticketRef));
if (refs.size !== incidents.length) problems.push("duplicate ticketRef");
const typesSeen = new Set(incidents.map((i) => i.serviceIssue.type));
ALL_TYPES.forEach((t) => { if (!typesSeen.has(t)) problems.push(`type missing: ${t}`); });

console.log("corpus:", incidents.length);
console.log("counts:", c);
console.log("types covered:", typesSeen.size, "/", ALL_TYPES.length);
console.log("lexical ⊆ hybrid:", LEXICAL_SET.every((t) => HYBRID_SET.includes(t)));
console.log("semantic ⊆ hybrid:", SEMANTIC_SET.every((t) => HYBRID_SET.includes(t)));
console.log("media docs:", mediaDocs.length, "| incidents with media:", new Set(mediaDocs.map((m) => m.ticketRef)).size, "| pool assets:", MEDIA_POOL.length);
console.log(problems.length ? "PROBLEMS:\n  " + problems.join("\n  ") : "all invariants hold");
