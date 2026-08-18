// ---------------------------------------------------------------------------
// Media pool and per-type attachment rules.
//
// Assets live in S3. This file defines WHICH kinds of artifact suit WHICH
// service types, and how captions are written. The pool itself (~45 files) is
// built once by scripts/build-media-pool.ts and referenced by poolId here.
// ---------------------------------------------------------------------------

import type { ServiceType } from "./types.ts";

export type MediaKind =
  | "image"           // photo — tower, generator, pedestal, hall, excavation
  | "document-page"   // PDF page rasterised — as-built, permit, work order
  | "table"           // CSV / inventory, rendered or as text
  | "text"            // field notes, work order body
  | "video-segment";  // scene from a longer clip

export type CapturedBy = "field-tech" | "drone" | "system" | "customer" | "vendor";

/** One entry in media-pool.json. The manifest the S3 build script produces. */
export interface PoolAsset {
  poolId: string;
  kind: MediaKind;
  /** S3 key, relative to the bucket. */
  key: string;
  mimeType: string;
  /** Which service types this asset plausibly belongs to. */
  applicableTypes: ServiceType[];
  /** Free tags used for caption selection and debugging. */
  tags: string[];
  /** document-page only. */
  pageNumber?: number;
  /** video-segment only. */
  video?: { startSec: number; endSec: number; fps: number; thumbnailKey: string };
}

/** Per-type attachment rules. */
export interface MediaSpec {
  /** Probability this incident gets any media at all. */
  probability: number;
  /** How many artifacts when it does. */
  countRange: [number, number];
  /** Kinds this type can carry, in rough preference order. */
  kinds: MediaKind[];
  /**
   * Caption templates. Tokens {field} resolve against the incident's
   * serviceIssue. The caption is what carries incident-specific semantics into
   * the multimodal embedding — the image itself is reused across incidents.
   */
  captions: Partial<Record<MediaKind, string[]>>;
}

export const MEDIA_SPECS: Record<ServiceType, MediaSpec> = {
  // ── infrastructure: excavation cascade — richest media ──
  fiber: {
    probability: 0.7, countRange: [1, 3],
    kinds: ["image", "document-page", "table"],
    captions: {
      image: [
        "Open pedestal at {spliceEnclosureId}, severed ribbon at conduit entry",
        "Exposed fibre run near {spliceEnclosureId}, jacket damage visible",
        "Splice technician working {ponPort} off {oltId}",
        "Damaged strand recovered at {otdrDistanceM}m from {oltId}",
      ],
      "document-page": [
        "Splice map as-built, {spliceEnclosureId} ring segment",
        "OTDR trace showing event at {otdrDistanceM}m on {ponPort}",
        "Fibre route drawing, {oltId} distribution",
      ],
      table: ["Optical power readings by port, {oltId}"],
    },
  },
  construction: {
    probability: 0.7, countRange: [1, 3],
    kinds: ["image", "document-page"],
    captions: {
      image: [
        "Bore rig on site, {projectCode}, {phase} phase",
        "Open trench at the {boreType} bore location, {projectCode}",
        "Crew {crewCode} staged pending {permitAuthority} approval",
      ],
      "document-page": [
        "Permit application filed with {permitAuthority} for {projectCode}",
        "Route drawing, {projectCode}, {blockedFootageM}m segment",
        "Locate ticket and utility markings, {projectCode}",
      ],
    },
  },
  backhaul: {
    probability: 0.45, countRange: [1, 2],
    kinds: ["image", "table", "video-segment"],
    captions: {
      image: [
        "Microwave path endpoint, {linkCode}, {pathLengthKm}km hop",
        "Dish and radome inspection, {linkCode}",
      ],
      table: ["Errored seconds log, {linkCode}, {erroredSeconds}s total"],
      "video-segment": ["Drone path survey along {linkCode}"],
    },
  },
  smartcell: {
    probability: 0.45, countRange: [1, 2],
    kinds: ["image", "video-segment"],
    captions: {
      image: [
        "Pole-mounted node {nodeId}, {mountType} installation",
        "Small cell {nodeId} with backhaul {backhaulLinkCode}",
      ],
      "video-segment": ["Drone pass over {nodeId} coverage area"],
    },
  },
  datacenter: {
    probability: 0.5, countRange: [1, 2],
    kinds: ["image", "document-page", "table"],
    captions: {
      image: [
        "Thermal image of {hallId} hot aisle, {temperatureC}C",
        "Rack rows in {hallId} at {facilityCode}",
        "CRAH unit {crahUnitId} access panel open",
      ],
      "document-page": ["Hall layout drawing, {hallId}, {facilityCode}"],
      table: ["Temperature readings by rack row, {hallId}"],
    },
  },
  edge: {
    probability: 0.25, countRange: [1, 1],
    kinds: ["image", "table"],
    captions: {
      image: ["Edge node {nodeId} cabinet, {k8sCluster}"],
      table: ["Pod scheduling failures on {nodeId}, {namespace}"],
    },
  },
  "cloud-network": {
    probability: 0.2, countRange: [1, 1],
    kinds: ["document-page", "table"],
    captions: {
      "document-page": ["Peering topology, AS{asn} at {peeringLocation}"],
      table: ["BGP session flap log, peer {bgpPeer}"],
    },
  },

  // ── consumer ──
  broadband: {
    probability: 0.3, countRange: [1, 2],
    kinds: ["image", "table"],
    captions: {
      image: [
        "Subscriber ONT panel, no light indication, {nodeId}",
        "Plant access point on {plantSegment}",
      ],
      table: ["Throughput samples on {nodeId}, {sharedSubscribers} subscribers"],
    },
  },
  "5g": {
    probability: 0.4, countRange: [1, 2],
    kinds: ["image", "video-segment", "table"],
    captions: {
      image: [
        "Sector {cellSector} antenna array on {towerId}",
        "Tower {towerId} looking up the {band} face",
      ],
      "video-segment": ["Drone inspection of {towerId}, sector {cellSector}"],
      table: ["Drive test samples, {driveTestRef}"],
    },
  },
  wireless: {
    probability: 0.15, countRange: [1, 1],
    kinds: ["table"],
    captions: { table: ["Throughput samples on {towerId} by hour"] },
  },
  "wifi-hotspot": {
    probability: 0.2, countRange: [1, 1],
    kinds: ["image", "table"],
    captions: {
      image: ["Access point {apModel} mounted at {venueName}"],
      table: ["Authentication failure log, {radiusRealm}"],
    },
  },

  // ── business ──
  voip: {
    probability: 0.15, countRange: [1, 1],
    kinds: ["document-page", "table"],
    captions: {
      "document-page": ["Call trace ladder diagram through {sbcNode}"],
      table: ["MOS samples by extension, {accountId}"],
    },
  },
  b2b: {
    probability: 0.15, countRange: [1, 1],
    kinds: ["document-page", "table"],
    captions: {
      "document-page": ["Customer topology, {customer}, {siteCount} sites"],
      table: ["Packet loss by site, tunnel {tunnelId}"],
    },
  },
  enterprise: {
    probability: 0.2, countRange: [1, 1],
    kinds: ["document-page", "table"],
    captions: {
      "document-page": ["Circuit as-built, {circuitId} at {handoffPop}"],
      table: ["Throughput vs committed, {circuitId}"],
    },
  },

  // ── emerging tech ──
  iot: {
    probability: 0.25, countRange: [1, 1],
    kinds: ["image", "table"],
    captions: {
      image: ["Installed endpoint {deviceId}, {fleet} fleet"],
      table: ["Uplink history for {fleet}, {fleetSize} devices"],
    },
  },
  satellite: {
    probability: 0.3, countRange: [1, 2],
    kinds: ["image", "table"],
    captions: {
      image: [
        "Sky view from terminal {terminalId}, obstruction check",
        "Dish alignment at {terminalId}, {elevationDeg} degrees",
      ],
      table: ["SNR samples on {beamId}"],
    },
  },
  "smart-city": {
    probability: 0.35, countRange: [1, 2],
    kinds: ["image", "document-page"],
    captions: {
      image: [
        "Last frame from {sensorId} before loss of contact",
        "Pole {poleId} at {streetAddress}, {assetType} mount",
      ],
      "document-page": ["Municipal asset map, {municipality}"],
    },
  },

  // ── federal ──
  "priority-access": {
    probability: 0.2, countRange: [1, 1],
    kinds: ["image", "document-page"],
    captions: {
      image: ["Dispatch console during {incidentTypeServed}"],
      "document-page": ["Coverage attestation for {towerId}"],
    },
  },
  government: {
    probability: 0.2, countRange: [1, 1],
    kinds: ["document-page", "table"],
    captions: {
      "document-page": ["Facility network topology, {facilityId}"],
      table: ["Failover event log, {primaryPath} to {failoverPath}"],
    },
  },
  "public-safety": {
    probability: 0.2, countRange: [1, 1],
    kinds: ["image", "table"],
    captions: {
      image: ["Console error state at {psapId}, code {errorCode}"],
      table: ["Call handling failures by hour, {psapId}"],
    },
  },
};

// ---------------------------------------------------------------------------
// The asset pool. Reused across incidents; captions carry the specificity.
// build-media-pool.ts sources these and uploads to S3, then writes the same
// manifest with real keys.
// ---------------------------------------------------------------------------

const IMG = (id: string, types: ServiceType[], tags: string[]): PoolAsset => ({
  poolId: id, kind: "image", key: `images/${id}.jpg`,
  mimeType: "image/jpeg", applicableTypes: types, tags,
});
const DOC = (id: string, types: ServiceType[], tags: string[], page = 1): PoolAsset => ({
  poolId: id, kind: "document-page", key: `docs/${id}-p${page}.png`,
  mimeType: "image/png", applicableTypes: types, tags, pageNumber: page,
});
const TBL = (id: string, types: ServiceType[], tags: string[]): PoolAsset => ({
  poolId: id, kind: "table", key: `tables/${id}.csv`,
  mimeType: "text/csv", applicableTypes: types, tags,
});
const VID = (id: string, types: ServiceType[], tags: string[],
             startSec: number, endSec: number): PoolAsset => ({
  poolId: id, kind: "video-segment", key: `video/${id}.mp4`,
  mimeType: "video/mp4", applicableTypes: types, tags,
  video: { startSec, endSec, fps: 4, thumbnailKey: `video/${id}-thumb.jpg` },
});

export const MEDIA_POOL: PoolAsset[] = [
  // ── photos: source from a stock API, ~25 files ──
  IMG("pedestal-open-01", ["fiber", "broadband"], ["pedestal", "cable", "damage"]),
  IMG("pedestal-open-02", ["fiber", "broadband"], ["pedestal", "splice"]),
  IMG("fiber-splice-01", ["fiber"], ["splice", "technician", "closure"]),
  IMG("fiber-splice-02", ["fiber"], ["splice", "fusion", "tray"]),
  IMG("cable-damage-01", ["fiber", "construction"], ["severed", "conduit"]),
  IMG("trench-open-01", ["construction", "fiber"], ["trench", "excavation"]),
  IMG("bore-rig-01", ["construction"], ["directional-bore", "rig"]),
  IMG("excavator-01", ["construction", "fiber"], ["excavator", "dig"]),
  IMG("utility-markings-01", ["construction"], ["locate", "paint", "row"]),
  IMG("tower-01", ["5g", "smartcell", "backhaul"], ["tower", "antenna"]),
  IMG("tower-02", ["5g", "backhaul"], ["tower", "microwave", "dish"]),
  IMG("tower-climb-01", ["5g", "smartcell"], ["technician", "tower", "maintenance"]),
  IMG("smallcell-pole-01", ["smartcell", "smart-city"], ["pole", "small-cell"]),
  IMG("microwave-dish-01", ["backhaul"], ["microwave", "dish", "radome"]),
  IMG("datacenter-hall-01", ["datacenter", "edge"], ["racks", "hall", "cold-aisle"]),
  IMG("datacenter-hall-02", ["datacenter"], ["racks", "hot-aisle"]),
  IMG("crah-unit-01", ["datacenter"], ["crah", "cooling", "hvac"]),
  IMG("thermal-hotaisle-01", ["datacenter"], ["thermal", "heat", "infrared"]),
  IMG("generator-01", ["datacenter", "smartcell"], ["generator", "diesel", "backup"]),
  IMG("noc-console-01", ["public-safety", "priority-access", "government"],
      ["console", "dispatch", "operations"]),
  IMG("ont-panel-01", ["broadband", "fiber"], ["ont", "modem", "subscriber"]),
  IMG("edge-cabinet-01", ["edge", "cloud-network"], ["cabinet", "compute"]),
  IMG("street-camera-01", ["smart-city"], ["camera", "pole", "municipal"]),
  IMG("iot-sensor-01", ["iot"], ["sensor", "endpoint", "field"]),
  IMG("satellite-dish-01", ["satellite"], ["vsat", "dish", "sky"]),
  IMG("wifi-ap-01", ["wifi-hotspot"], ["access-point", "venue"]),

  // ── generated documents, ~10 pages ──
  DOC("splice-map", ["fiber", "construction"], ["as-built", "ring", "enclosure"], 14),
  DOC("splice-map", ["fiber"], ["as-built", "ring"], 15),
  DOC("otdr-trace", ["fiber"], ["otdr", "trace", "event"]),
  DOC("route-drawing", ["construction", "fiber"], ["route", "plan"]),
  DOC("permit-application", ["construction"], ["permit", "row", "form"]),
  DOC("locate-ticket", ["construction"], ["locate", "811", "ticket"]),
  DOC("circuit-asbuilt", ["enterprise", "b2b"], ["circuit", "handoff"]),
  DOC("call-trace", ["voip"], ["ladder", "sip", "trace"]),
  DOC("hall-layout", ["datacenter"], ["floorplan", "racks"]),
  DOC("peering-topology", ["cloud-network"], ["bgp", "peering"]),
  DOC("facility-topology", ["government"], ["network", "facility"]),
  DOC("coverage-attestation", ["priority-access"], ["coverage", "rf"]),
  DOC("municipal-asset-map", ["smart-city"], ["assets", "municipal"]),

  // ── generated tables, ~8 files ──
  TBL("optical-power-readings", ["fiber"], ["optical", "power"]),
  TBL("errored-seconds-log", ["backhaul"], ["errors", "transport"]),
  TBL("throughput-samples", ["broadband", "wireless", "enterprise"], ["throughput"]),
  TBL("temperature-readings", ["datacenter"], ["thermal", "rack"]),
  TBL("bgp-flap-log", ["cloud-network"], ["bgp", "flap"]),
  TBL("auth-failure-log", ["wifi-hotspot"], ["radius", "auth"]),
  TBL("mos-samples", ["voip"], ["mos", "voice"]),
  TBL("uplink-history", ["iot"], ["uplink", "fleet"]),
  TBL("snr-samples", ["satellite"], ["snr", "beam"]),
  TBL("drive-test", ["5g"], ["drive-test", "rf"]),
  TBL("pod-failures", ["edge"], ["kubernetes", "scheduling"]),
  TBL("failover-log", ["government"], ["failover", "rto"]),
  TBL("call-failures", ["public-safety"], ["cad", "calls"]),
  TBL("packet-loss-by-site", ["b2b"], ["loss", "sites"]),

  // ── video, deferred but shaped ──
  VID("drone-tower-pass", ["5g", "smartcell"], ["drone", "tower", "aerial"], 84, 96),
  VID("drone-path-survey", ["backhaul"], ["drone", "path", "aerial"], 12, 26),
  VID("drone-coverage", ["smartcell"], ["drone", "coverage"], 40, 55),
];
