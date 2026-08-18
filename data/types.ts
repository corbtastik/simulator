// ---------------------------------------------------------------------------
// Type specifications for all 20 service types across 5 categories.
// Each spec drives narrative generation, type-specific fields, and impact units.
// ---------------------------------------------------------------------------

export type Category =
  | "business" | "consumer" | "emerging_tech" | "federal" | "infrastructure";

export type ServiceType =
  | "b2b" | "enterprise" | "voip"
  | "5g" | "broadband" | "fiber" | "wifi-hotspot" | "wireless"
  | "iot" | "satellite" | "smart-city"
  | "priority-access" | "government" | "public-safety"
  | "backhaul" | "cloud-network" | "construction" | "datacenter" | "edge" | "smartcell";

export type Severity = "p1" | "p2" | "p3" | "p4";
export type ReportedBy = "customer" | "alarm" | "field-tech" | "proactive";
export type ImpactScope = "single" | "segment" | "metro" | "region";

export interface TypeSpec {
  category: Category;
  issue: string;
  impactUnit: string;
  impactRange: [number, number];
  symptoms: string[];
  /** Weighted phrasings. No single phrasing should exceed ~20% of that type. */
  phrasings: string[];
  /** Builds the type-specific fields inside serviceIssue. */
  fields: (r: () => number, pick: <T>(a: T[]) => T) => Record<string, unknown>;
  /** Sentence template. {phrasing} and {field} tokens get substituted. */
  template: (f: Record<string, any>, phrasing: string, impact: number) => string;
  /** True when this type can plausibly be part of an excavation-damage cascade. */
  digRelated: boolean;
  crew: string;
  parts: string[];
  costBase: number;
}

const rint = (r: () => number, lo: number, hi: number) =>
  Math.floor(r() * (hi - lo + 1)) + lo;
const rfloat = (r: () => number, lo: number, hi: number, dp = 1) =>
  Number((r() * (hi - lo) + lo).toFixed(dp));
const pad = (n: number, w = 3) => String(n).padStart(w, "0");

export const TYPE_SPECS: Record<ServiceType, TypeSpec> = {
  // ─────────────────────────── business ───────────────────────────
  b2b: {
    category: "business",
    issue: "packet-loss",
    impactUnit: "sites",
    impactRange: [2, 40],
    symptoms: ["packet-loss", "tunnel-degraded", "no-cpe-alarm"],
    phrasings: [
      "reporting sustained packet loss",
      "seeing dropped frames across the mesh",
      "reporting a degraded site-to-site tunnel",
      "flagging intermittent drops on the WAN",
      "says traffic is not making it across",
      "reporting instability between branch sites",
    ],
    fields: (r, pick) => ({
      customer: pick(["Vertex Aerospace", "Meridian Logistics", "Caldera Energy", "Ironwood Manufacturing", "Blue Harbor Shipping"]),
      circuitId: `CKT-${rint(r, 10000, 89999)}`,
      tunnelId: `VPN-${pick(["DFW", "ATL", "DEN", "CHI"])}-${rint(r, 100, 999)}`,
      lossPercent: rfloat(r, 0.4, 8.5),
      slaTier: pick(["bronze", "silver", "gold"]),
      contractedUptimePct: pick([99.5, 99.9, 99.95]),
    }),
    template: (f, p, n) =>
      `${f.customer} ${p} across ${n}-site VPN mesh. ${f.lossPercent}% sustained on ${f.tunnelId}. No alarms on the local CPE. Escalating to transport.`,
    digRelated: false,
    crew: "network",
    parts: ["cpe-swap"],
    costBase: 1200,
  },

  enterprise: {
    category: "business",
    issue: "throughput-drop",
    impactUnit: "sites",
    impactRange: [1, 12],
    symptoms: ["throughput-drop", "sla-risk", "latency-high"],
    phrasings: [
      "reporting a throughput drop",
      "seeing a bandwidth shortfall",
      "says the circuit is underperforming",
      "not getting rated speed on the handoff",
      "reporting slow transfers to the DC",
      "says the pipe is choked during business hours",
    ],
    fields: (r, pick) => ({
      customer: pick(["Vertex Aerospace", "Northgate Financial", "Copperline Retail", "Lantern Hospitality", "Stonebridge Health"]),
      circuitId: `CKT-${rint(r, 10000, 89999)}`,
      committedMbps: pick([500, 1000, 2000, 10000]),
      observedMbps: rint(r, 60, 480),
      latencyMs: rint(r, 40, 260),
      slaBreachMinutes: rint(r, 5, 180),
      handoffPop: pick(["DFW-02", "ATL-01", "CHI-04", "LAX-03"]),
    }),
    template: (f, p, n) =>
      `${f.customer} ${p} on ${f.circuitId}. Committed ${f.committedMbps}, observing ${f.observedMbps}. Latency ${f.latencyMs}ms at ${f.handoffPop}. SLA clock at ${f.slaBreachMinutes}min across ${n} sites.`,
    digRelated: false,
    crew: "network",
    parts: [],
    costBase: 2400,
  },

  voip: {
    category: "business",
    issue: "one-way-audio",
    impactUnit: "extensions",
    impactRange: [5, 180],
    symptoms: ["one-way-audio", "jitter-high", "mos-low"],
    phrasings: [
      "reporting one-way audio",
      "says the caller cannot hear them",
      "reporting dead air on inbound calls",
      "seeing audio dropout mid-call",
      "says calls connect but there is no sound",
      "reporting half-duplex audio on the trunk",
    ],
    fields: (r, pick) => ({
      accountId: `VOIP-${rint(r, 100, 999)}`,
      pbxVendor: pick(["UCM-9000", "AuraCore", "MiVoice-X", "CloudPBX"]),
      codec: pick(["G.711", "G.729", "Opus"]),
      mosScore: rfloat(r, 1.6, 3.4, 1),
      jitterMs: rint(r, 30, 220),
      sbcNode: `SBC-${pick(["DFW", "ATL", "CHI"])}-0${rint(r, 1, 6)}`,
    }),
    template: (f, p, n) =>
      `Customer ${p} through ${f.sbcNode}. MOS ${f.mosScore}, jitter ${f.jitterMs}ms. ${n} extensions affected. ${f.pbxVendor} side shows no faults.`,
    digRelated: true,
    crew: "voice",
    parts: [],
    costBase: 900,
  },

  // ─────────────────────────── consumer ───────────────────────────
  "5g": {
    category: "consumer",
    issue: "handover-failure",
    impactUnit: "subscribers",
    impactRange: [80, 3200],
    symptoms: ["handover-failure", "sinr-low", "sector-flap"],
    phrasings: [
      "handover failures logged",
      "subscribers dropping when moving between towers",
      "calls cutting out along the corridor",
      "sector flapping under load",
      "failed cell reselection events",
      "devices ping-ponging between cells",
    ],
    fields: (r, pick) => ({
      towerId: `${pick(["POR", "DEN", "PHX", "SEA", "MIA"])}-5G-${rint(r, 100, 999)}`,
      cellSector: `Sector-${pick(["A", "B", "C"])}`,
      band: pick(["n77", "n41", "n260"]),
      rsrpDbm: rint(r, -125, -95),
      sinrDb: rfloat(r, -2, 9, 1),
      failedHandovers: rint(r, 6, 140),
      deviceModel: pick(["Handset A17", "Handset P9", "Handset S26"]),
    }),
    template: (f, p, n) =>
      `${f.failedHandovers} ${p} on ${f.towerId}/${f.cellSector}, band ${f.band}. RSRP ${f.rsrpDbm}dBm, SINR ${f.sinrDb}dB. Roughly ${n} subscribers in the footprint.`,
    digRelated: false,
    crew: "rf",
    parts: [],
    costBase: 1800,
  },

  broadband: {
    category: "consumer",
    issue: "packet-loss",
    impactUnit: "subscribers",
    impactRange: [20, 900],
    symptoms: ["packet-loss", "throughput-low", "snr-degraded"],
    phrasings: [
      "reporting slow internet",
      "says they are not getting the speeds they pay for",
      "reporting constant buffering",
      "seeing packet loss on the node",
      "says the connection keeps stalling",
      "reporting drops during video calls",
      "says the internet just quit with no lights on the ONT",
    ],
    fields: (r, pick) => ({
      accountId: `BB-${rint(r, 100, 999)}`,
      modemModel: pick(["RG-320", "RG-210", "NVG-468"]),
      nodeId: `NODE-${pick(["HTS", "MCA", "WAR", "TER"])}-${pad(rint(r, 1, 99), 3)}`,
      snrDb: rfloat(r, 12, 34, 1),
      downstreamMbps: rfloat(r, 1.2, 42, 1),
      expectedMbps: pick([100, 300, 500, 1000]),
      plantSegment: `SEG-${rint(r, 1, 40)}`,
    }),
    template: (f, p, n) =>
      `Subscriber on ${f.nodeId} ${p}. Getting ${f.downstreamMbps} of ${f.expectedMbps}. SNR ${f.snrDb}dB on ${f.modemModel}. ${n} subs share ${f.plantSegment}.`,
    digRelated: true,
    crew: "outside-plant",
    parts: ["tap-replacement"],
    costBase: 640,
  },

  fiber: {
    category: "consumer",
    issue: "light-level-low",
    impactUnit: "subscribers",
    impactRange: [40, 1400],
    symptoms: ["light-level-low", "fiber-cut", "third-party-dig"],
    phrasings: [
      "Optical power collapsed",
      "Light levels dropped below threshold",
      "Loss of signal on the PON",
      "Severed strand confirmed on the segment",
      "Optical power drop with OTDR event",
      "backhoe strike confirmed on the route",     // literal "backhoe" — capped
      "Third-party excavation severed the run",
      "Contractor dig-up took out the feeder",
      "Trencher damage located mid-span",
      "Contractor hit our line during boring",
    ],
    fields: (r, pick) => ({
      accountId: `FBR-${rint(r, 100, 999)}`,
      oltId: `OLT-${pick(["MCA", "WAR", "TER", "PER", "LOC"])}-${pad(rint(r, 1, 20), 2)}`,
      ponPort: `${rint(r, 1, 4)}/${rint(r, 1, 8)}/${rint(r, 1, 8)}`,
      opticalPowerDbm: rfloat(r, -34, -24, 1),
      expectedPowerDbm: -19.0,
      spliceEnclosureId: `SE-${pick(["MCA", "WAR", "TER", "PER"])}-${rint(r, 1000, 2999)}`,
      otdrDistanceM: rint(r, 400, 4200),
      suspectedCause: pick(["third-party-dig", "rodent", "storm", "unknown"]),
    }),
    template: (f, p, n) =>
      `${p} on PON ${f.ponPort} off ${f.oltId}. Reading ${f.opticalPowerDbm}dBm against ${f.expectedPowerDbm} nominal. OTDR places the event at ${f.otdrDistanceM}m, just past the ${f.spliceEnclosureId} enclosure. ${n} subscribers dark.`,
    digRelated: true,
    crew: "splice",
    parts: ["48ct-ribbon", "splice-enclosure-SE-12"],
    costBase: 3840,
  },

  "wifi-hotspot": {
    category: "consumer",
    issue: "captive-portal-loop",
    impactUnit: "clients",
    impactRange: [10, 400],
    symptoms: ["captive-portal-loop", "auth-failure", "radius-timeout"],
    phrasings: [
      "reporting a captive portal loop",
      "cannot get past the sign-in page",
      "says the login screen keeps reloading",
      "stuck in an auth loop after accepting terms",
      "bounced back to the splash page repeatedly",
      "reporting RADIUS timeouts at association",
    ],
    fields: (r, pick) => ({
      ssid: `citywifi-${pick(["REDBIRD", "TRANSIT", "MALLNORTH", "CAMPUS"])}`,
      apModel: pick(["AP-635", "AP-9130", "AP-R750"]),
      venueName: pick(["Redbird Transit Center", "Northgate Mall", "Civic Plaza", "Union Station"]),
      venueType: pick(["transit", "retail", "civic", "campus"]),
      radiusRealm: "wifi.prod",
      authFailuresLastHour: rint(r, 20, 400),
    }),
    template: (f, p, n) =>
      `Users ${p} at ${f.venueName}. ${f.authFailuresLastHour} auth failures in the last hour against ${f.radiusRealm}. ${n} clients associated on ${f.apModel}.`,
    digRelated: false,
    crew: "wifi",
    parts: [],
    costBase: 480,
  },

  wireless: {
    category: "consumer",
    issue: "throttling",
    impactUnit: "subscribers",
    impactRange: [100, 2400],
    symptoms: ["throttling", "deprioritized", "cap-exceeded"],
    phrasings: [
      "reporting throttled speeds",
      "says they were slowed after the cap",
      "reporting deprioritization during congestion",
      "says data got cut back mid-cycle",
      "reporting dial-up speeds on LTE fallback",
      "says speeds are capped even off-peak",
    ],
    fields: (r, pick) => ({
      towerId: `${pick(["FOR", "SWI", "PER", "TER"])}-TWR-${rint(r, 100, 999)}`,
      planCode: pick(["UNL-PREMIUM", "UNL-STARTER", "UNL-EXTRA"]),
      dataUsedGb: rfloat(r, 22, 140, 1),
      dataCapGb: pick([22, 50, 75]),
      deprioritizationTier: rint(r, 1, 3),
      deviceModel: pick(["Handset P9", "Handset A17", "Handset A56"]),
    }),
    template: (f, p, n) =>
      `Subscriber on ${f.planCode} ${p} after ${f.dataUsedGb}GB against a ${f.dataCapGb}GB threshold. Tier ${f.deprioritizationTier} deprioritization active on ${f.towerId}. ${n} subscribers on the sector.`,
    digRelated: false,
    crew: "rf",
    parts: [],
    costBase: 300,
  },

  // ───────────────────────── emerging_tech ─────────────────────────
  iot: {
    category: "emerging_tech",
    issue: "no-uplink",
    impactUnit: "devices",
    impactRange: [3, 900],
    symptoms: ["no-uplink", "device-offline", "battery-low"],
    phrasings: [
      "No uplink since last check-in",
      "Devices offline across the fleet",
      "Sensors stopped reporting overnight",
      "Endpoints have gone dark",
      "Fleet has not checked in since yesterday",
      "Lost contact with the endpoint group",
    ],
    fields: (r, pick) => ({
      deviceId: `SIM-${rint(r, 10000000, 99999999)}`,
      fleet: pick(["Fiber Attenuator", "Tank Level", "Cold Chain", "Meter Reader"]),
      rat: pick(["LTE-M", "NB-IoT", "CAT-1"]),
      firmwareVersion: `${rint(r, 1, 4)}.${rint(r, 0, 9)}.${rint(r, 0, 9)}`,
      batteryPct: rint(r, 2, 60),
      fleetSize: rint(r, 200, 3000),
    }),
    template: (f, p, n) =>
      `${p} — ${f.deviceId} on ${f.rat}, firmware ${f.firmwareVersion}. Battery ${f.batteryPct}%. ${n} of ${f.fleetSize} devices in ${f.fleet} also silent.`,
    digRelated: false,
    crew: "iot",
    parts: ["sim-swap"],
    costBase: 260,
  },

  satellite: {
    category: "emerging_tech",
    issue: "signal-degradation",
    impactUnit: "terminals",
    impactRange: [1, 120],
    symptoms: ["signal-degradation", "rain-fade", "obstruction"],
    phrasings: [
      "Signal degradation on the beam",
      "Rain fade knocking out the link",
      "Terminal cannot hold lock",
      "SNR collapsed with clear sky",
      "Link margin gone on the downlink",
      "Dish obstruction suspected",
    ],
    fields: (r, pick) => ({
      terminalId: `SAT-${rint(r, 1000, 9999)}`,
      beamId: `BEAM-${pick(["SE", "NW", "MW", "SW"])}-${rint(r, 1, 30)}`,
      snrDb: rfloat(r, 4, 12, 1),
      expectedSnrDb: 14.0,
      elevationDeg: rfloat(r, 18, 62, 1),
      orbitClass: pick(["GEO", "MEO", "LEO"]),
      rainFadeMm: rfloat(r, 0, 34, 1),
    }),
    template: (f, p, n) =>
      `${p} on ${f.terminalId}, ${f.beamId}. SNR ${f.snrDb}dB against ${f.expectedSnrDb} nominal. Elevation ${f.elevationDeg}°, ${f.orbitClass}. ${n} terminals on the beam.`,
    digRelated: false,
    crew: "satellite",
    parts: [],
    costBase: 1100,
  },

  "smart-city": {
    category: "emerging_tech",
    issue: "connectivity-loss",
    impactUnit: "assets",
    impactRange: [1, 60],
    symptoms: ["connectivity-loss", "asset-offline", "power-fault"],
    phrasings: [
      "Connectivity loss on the pole asset",
      "Camera offline since the overnight window",
      "Node unreachable from the poller",
      "Sensor dark with no heartbeat",
      "Asset dropped off the municipal network",
      "Not responding to scheduled polls",
    ],
    fields: (r, pick) => ({
      sensorId: `${pick(["CAM", "LGT", "MTR", "AQI"])}-${pick(["FON", "MCA", "WAR"])}-${rint(r, 100, 999)}`,
      assetType: pick(["traffic-camera", "streetlight", "parking-meter", "air-quality"]),
      poleId: `POLE-${pick(["FON", "MCA", "WAR"])}-${rint(r, 1000, 1999)}`,
      streetAddress: pick(["E 5th Street", "N Main Ave", "Depot Road", "Central Parkway"]),
      municipality: pick(["Fontenelle", "McArthur", "Warrior", "Terry"]),
      powerSource: pick(["pole-tap", "metered", "solar"]),
    }),
    template: (f, p, n) =>
      `${p}. ${f.assetType} ${f.sensorId} at ${f.streetAddress}, mounted on ${f.poleId}, ${f.powerSource}. ${n} assets on the segment for ${f.municipality}.`,
    digRelated: true,
    crew: "municipal",
    parts: [],
    costBase: 520,
  },

  // ─────────────────────────── federal ───────────────────────────
  "priority-access": {
    category: "federal",
    issue: "priority-preemption",
    impactUnit: "units",
    impactRange: [1, 40],
    symptoms: ["priority-preemption", "qos-not-applied", "band14-fallback"],
    phrasings: [
      "Preemption not applied on scene",
      "Priority did not take during the incident",
      "Units bumped off during an active call",
      "QoS not honored on the sector",
      "Responders treated as normal subscribers",
      "Lost priority mid-incident",
    ],
    fields: (r, pick) => ({
      agency: pick(["Fairview PD", "Clearwater County EMS", "Ridgeport FD", "State Highway Patrol"]),
      unitId: `${pick(["FPD", "CCE", "RFD"])}-UNIT-${rint(r, 10, 99)}`,
      qciClass: pick([65, 66, 69]),
      bandClass: "B14",
      incidentTypeServed: pick(["active-scene", "mutual-aid", "pursuit", "wildfire"]),
      preemptionEvents: rint(r, 1, 24),
      towerId: `${pick(["FVW", "RDG", "CLW"])}-PA-${rint(r, 100, 999)}`,
    }),
    template: (f, p, n) =>
      `${p}. ${f.agency} ${f.unitId} during ${f.incidentTypeServed}. ${f.preemptionEvents} events on ${f.towerId}, QCI ${f.qciClass} on ${f.bandClass}. ${n} units affected.`,
    digRelated: false,
    crew: "public-safety",
    parts: [],
    costBase: 1600,
  },

  government: {
    category: "federal",
    issue: "redundancy-failover",
    impactUnit: "users",
    impactRange: [20, 1200],
    symptoms: ["redundancy-failover", "rto-breach", "path-down"],
    phrasings: [
      "Failover did not cut over cleanly",
      "Redundancy failed at the facility",
      "Secondary path down alongside primary",
      "No automatic switchover occurred",
      "Protection path did not engage",
      "Both circuits went together",
    ],
    fields: (r, pick) => ({
      department: pick(["Regional Postal Ops", "Federal Facilities Group", "Veterans Medical Center", "Revenue Service Campus"]),
      contractVehicle: pick(["Vehicle A", "Vehicle B", "Vehicle C"]),
      facilityId: `FAC-${pick(["RPO", "FFG", "VMC"])}-${rint(r, 1000, 9999)}`,
      primaryPath: `CKT-A-${rint(r, 1000, 9999)}`,
      failoverPath: `CKT-B-${rint(r, 1000, 9999)}`,
      rtoMinutes: pick([5, 15, 30]),
      actualFailoverSec: rint(r, 60, 900),
      classification: "unclassified",
    }),
    template: (f, p, n) =>
      `${p} at ${f.facilityId}. ${f.primaryPath} dropped, ${f.failoverPath} took ${f.actualFailoverSec}s against a ${f.rtoMinutes}min RTO. ${n} users on site. ${f.contractVehicle} contract.`,
    digRelated: true,
    crew: "network",
    parts: [],
    costBase: 2200,
  },

  "public-safety": {
    category: "federal",
    issue: "dispatch-app-error",
    impactUnit: "calls",
    impactRange: [2, 200],
    symptoms: ["dispatch-app-error", "cad-failure", "ng911-degraded"],
    phrasings: [
      "CAD errors at the PSAP",
      "Dispatch app crashing on console load",
      "Cannot push calls to units",
      "Console throwing errors on assignment",
      "911 routing problem reported",
      "Call handling system degraded",
    ],
    fields: (r, pick) => ({
      agency: pick(["Fairview PD", "Clearwater County 911", "Ridgeport EMS"]),
      psapId: `PSAP-${pick(["TX", "AL", "GA"])}-${pad(rint(r, 1, 999), 4)}`,
      appVersion: `${rint(r, 3, 5)}.${rint(r, 0, 20)}.${rint(r, 0, 9)}`,
      errorCode: `CAD-${pick([500, 502, 503, 504])}`,
      ng911Enabled: true,
      failoverPsap: `PSAP-${pick(["TX", "AL", "GA"])}-${pad(rint(r, 1, 999), 4)}`,
    }),
    template: (f, p, n) =>
      `${p}. ${f.errorCode} on app ${f.appVersion} at ${f.psapId}, ${n} calls affected. NG911 enabled. Considering failover to ${f.failoverPsap}.`,
    digRelated: false,
    crew: "public-safety",
    parts: [],
    costBase: 1900,
  },

  // ───────────────────────── infrastructure ─────────────────────────
  backhaul: {
    category: "infrastructure",
    issue: "los-increase",
    impactUnit: "sites",
    impactRange: [1, 24],
    symptoms: ["los-increase", "errored-seconds", "unprotected"],
    phrasings: [
      "LOS increase on the link",
      "Errored seconds climbing steadily",
      "Path fade on the microwave hop",
      "Saturated backhaul during peak",
      "Congestion on the transport link",
      "Errored seconds spiking, path unprotected",
      "Transport segment degraded after ground work nearby",
    ],
    fields: (r, pick) => ({
      linkCode: `BH-${pick(["SWI", "WAR", "MCA", "POR"])}-${rint(r, 100, 999)}`,
      mediaType: pick(["microwave", "fiber", "leased"]),
      capacityGbps: pick([1, 10, 40]),
      pathLengthKm: rfloat(r, 3, 42, 1),
      erroredSeconds: rint(r, 60, 4000),
      protectionState: pick(["protected", "unprotected"]),
      rslDbm: rint(r, -86, -58),
      utilizationPct: rfloat(r, 62, 99, 1),
    }),
    template: (f, p, n) =>
      `${p} on ${f.linkCode} (${f.mediaType}, ${f.pathLengthKm}km). Utilization ${f.utilizationPct}%, ${f.erroredSeconds} errored seconds. RSL ${f.rslDbm}dBm. ${n} sites behind this link, ${f.protectionState}.`,
    digRelated: true,
    crew: "transport",
    parts: ["radio-swap"],
    costBase: 2600,
  },

  "cloud-network": {
    category: "infrastructure",
    issue: "route-flap",
    impactUnit: "prefixes",
    impactRange: [10, 2000],
    symptoms: ["route-flap", "bgp-instability", "prefix-withdrawal"],
    phrasings: [
      "Route flap on the peering session",
      "BGP session bouncing repeatedly",
      "Prefixes withdrawn without warning",
      "Peer instability across the exchange",
      "Adjacency will not hold",
      "Session keeps resetting under load",
    ],
    fields: (r, pick) => ({
      customer: pick(["Cloud Provider A Direct", "Cloud Provider B Interconnect", "Cloud Provider C Express"]),
      bgpPeer: `${rint(r, 10, 220)}.${rint(r, 0, 255)}.${rint(r, 0, 255)}.${rint(r, 1, 254)}`,
      asn: rint(r, 64512, 65534),
      peeringLocation: pick(["DFW-EQX-DA6", "ATL-EQX-AT2", "CHI-EQX-CH1"]),
      circuitBandwidthGbps: pick([1, 10, 100]),
      prefixCount: rint(r, 200, 4000),
      flapCount: rint(r, 4, 120),
      sessionUptimeSec: rint(r, 20, 900),
    }),
    template: (f, p, n) =>
      `${p} with AS${f.asn} at ${f.peeringLocation}. ${f.flapCount} flaps, session up ${f.sessionUptimeSec}s. ${n} of ${f.prefixCount} prefixes withdrawn on the ${f.circuitBandwidthGbps}G circuit to ${f.customer}.`,
    digRelated: false,
    crew: "network",
    parts: [],
    costBase: 3100,
  },

  construction: {
    category: "infrastructure",
    issue: "permit-delay",
    impactUnit: "passings",
    impactRange: [200, 4000],
    symptoms: ["permit-delay", "row-hold", "crew-idle"],
    phrasings: [
      "Permit delay holding the build",
      "Waiting on the municipality for sign-off",
      "ROW hold in effect",
      "Crew standing down pending authority approval",
      "Cannot break ground until permits clear",
      "Directional bore contacted unmarked conduit",
      "Bore crew struck an unmarked duct bank",
      "Excavation halted after striking buried plant",
    ],
    fields: (r, pick) => ({
      projectCode: `FBR-${pick(["LOC", "WAR", "MCA", "TER"])}-${rint(r, 100, 999)}`,
      crewCode: `CRW-${rint(r, 1000, 9999)}`,
      contractor: pick(["Cardinal Builders", "Ridgeline Construction", "Summit Infrastructure", "Keystone Utilities"]),
      phase: pick(["survey", "permitting", "boring", "pulling", "splicing", "restoration"]),
      permitAuthority: pick(["Eddy County ROW", "Clearwater County ROW", "City of Terry"]),
      blockedFootageM: rint(r, 60, 1800),
      boreType: pick(["directional", "open-cut", "plow"]),
      crewIdleDays: rint(r, 0, 21),
      adjacentAssets: [`SE-${pick(["WAR", "MCA"])}-${rint(r, 1000, 1999)}`],
    }),
    template: (f, p, n) =>
      `${f.projectCode}: ${p}. ${f.permitAuthority}, phase ${f.phase}. ${f.blockedFootageM}m of ${f.boreType} bore blocked. ${f.contractor} crew ${f.crewCode} idle ${f.crewIdleDays} days. ${n} planned passings at risk.`,
    digRelated: true,
    crew: "construction",
    parts: [],
    costBase: 5400,
  },

  datacenter: {
    category: "infrastructure",
    issue: "cooling-alert",
    impactUnit: "racks",
    impactRange: [2, 90],
    symptoms: ["cooling-alert", "thermal-excursion", "redundancy-lost"],
    phrasings: [
      "Cooling alert in the hall",
      "Hot aisle temperature climbing",
      "CRAH unit degraded",
      "Thermal excursion above setpoint",
      "Air handler down on the row",
      "Losing thermal headroom fast",
    ],
    fields: (r, pick) => ({
      facilityCode: `DC-${pick(["JUN", "MCA", "WAR", "DFW"])}-0${rint(r, 1, 9)}`,
      hallId: `HALL-${pick(["A", "B", "C"])}`,
      crahUnitId: `CRAH-${pick(["A", "B"])}-0${rint(r, 1, 8)}`,
      temperatureC: rfloat(r, 24, 36, 1),
      setpointC: 22.0,
      deltaT: rfloat(r, 2, 14, 1),
      redundancyMode: pick(["N+1", "2N"]),
      redundancyLost: true,
      rackRows: [`R${rint(r, 10, 20)}`, `R${rint(r, 10, 20)}`],
    }),
    template: (f, p, n) =>
      `${p} in ${f.hallId} at ${f.facilityCode}. ${f.temperatureC}°C against ${f.setpointC} setpoint, delta-T ${f.deltaT}. ${f.crahUnitId} degraded, ${f.redundancyMode} redundancy lost. ${n} racks at risk.`,
    digRelated: false,
    crew: "facilities",
    parts: ["crah-compressor"],
    costBase: 7200,
  },

  edge: {
    category: "infrastructure",
    issue: "registry-throttle",
    impactUnit: "workloads",
    impactRange: [1, 60],
    symptoms: ["registry-throttle", "image-pull-backoff", "cpu-saturation"],
    phrasings: [
      "Registry throttling image pulls",
      "Image pull backoff across the node",
      "Pods stuck pending on scheduling",
      "Cannot pull containers from the registry",
      "Rate limited by the upstream registry",
      "CPU saturation on the edge node",
    ],
    fields: (r, pick) => ({
      nodeId: `EDGE-${pick(["TER", "MCA", "WAR", "CHI"])}-${rint(r, 100, 999)}`,
      k8sCluster: `edge-${pick(["central", "east", "west"])}-0${rint(r, 1, 9)}`,
      namespace: pick(["mec-workloads", "ran-analytics", "video-edge"]),
      cpuUtilization: rint(r, 70, 99),
      memUtilizationPct: rint(r, 50, 96),
      imagePullFailures: rint(r, 10, 400),
      workload: pick(["video-analytics", "ran-intelligent-controller", "cdn-cache"]),
      nodeVersion: `v1.${rint(r, 28, 33)}.${rint(r, 0, 9)}`,
    }),
    template: (f, p, n) =>
      `${p} on ${f.nodeId} in ${f.k8sCluster}/${f.namespace}. ${f.imagePullFailures} pull failures, ${n} workloads pending. CPU ${f.cpuUtilization}%, mem ${f.memUtilizationPct}%. ${f.workload} degraded.`,
    digRelated: false,
    crew: "platform",
    parts: [],
    costBase: 1400,
  },

  smartcell: {
    category: "infrastructure",
    issue: "backhaul-down",
    impactUnit: "subscribers",
    impactRange: [80, 1500],
    symptoms: ["backhaul-down", "no-heartbeat", "site-dark"],
    phrasings: [
      "No heartbeat from the node",
      "Cell down and unreachable",
      "Node stopped reporting entirely",
      "Site dark since the overnight window",
      "Small cell dropped off the network",
      "Lost the node after nearby ground work",
    ],
    fields: (r, pick) => ({
      nodeId: `SC-${pick(["POR", "WAR", "MCA", "TER"])}-${rint(r, 100, 999)}`,
      vendor: pick(["StreetMacro SM-200", "AirScale AS-40", "CompactLink CL-12"]),
      mountType: pick(["pole", "rooftop", "strand", "monopole"]),
      poleOwner: pick(["Regional Power Co", "Valley Electric", "Municipal Utilities"]),
      powerFeed: pick(["metered", "unmetered"]),
      sectorCount: rint(r, 1, 3),
      backhaulLinkCode: `BH-${pick(["POR", "WAR", "MCA"])}-${rint(r, 100, 999)}`,
      coverageAreaKm2: rfloat(r, 0.1, 1.4, 2),
    }),
    template: (f, p, n) =>
      `${p} — ${f.nodeId} (${f.vendor}, ${f.mountType}). Backhaul ${f.backhaulLinkCode}. ${f.sectorCount} sectors, roughly ${n} subscribers losing offload.`,
    digRelated: true,
    crew: "rf",
    parts: ["node-swap"],
    costBase: 2900,
  },
};

export const ALL_TYPES = Object.keys(TYPE_SPECS) as ServiceType[];
