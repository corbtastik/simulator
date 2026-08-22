// Routes repair_started events to infrastructure_events collection
const CATEGORY    = "infrastructure";
const TARGET_COLL = "infrastructure_events";

let source = {
  $source: {
    connectionName: "fix-events",
    db: "incidents",
    coll: "fix_events",
  }
};

let match_repair_started = {
  $match: {
    "fullDocument.type": "repair_started",
    "fullDocument.category": CATEGORY
  }
};

let format_record = {
  $project: {
    _id: 0,
    type: { $literal: "repair_started" },
    incidentId: "$fullDocument.incidentId",
    repairStartedAt: "$fullDocument.repairStartedAt",
    expectedFixAt: "$fullDocument.expectedFixAt",
    meta: {
      from: { $literal: "fix_events" },
      simRunId: "$fullDocument.simRunId",
      policy: "$fullDocument.policy",
      version: "$fullDocument.version"
    }
  }
};

let write_to_target = {
  $merge: {
    into: {
      connectionName: "fix-events",
      db: "incidents",
      coll: TARGET_COLL,
    },
    on: ["incidentId", "type"],
    whenMatched: "keepExisting",
    whenNotMatched: "insert"
  }
};

let pipeline = [
  source,
  match_repair_started,
  format_record,
  write_to_target
];

sp.createStreamProcessor("repair_started_infrastructure", pipeline);
sp.repair_started_infrastructure.start();
