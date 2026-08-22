// ----- CHANGE THESE TWO PER PROCESSOR -----
const CATEGORY    = "consumer";
const TARGET_COLL = "consumer_events";
// -----------------------------------------

let fix_events_source = {
  $source: {
    connectionName: "fix-events", // MongoDB source connection
    db: "incidents",
    coll: "fix_events",
  }
};

let match_category = {
  $match: {
    "fullDocument.type": "fix",
    "fullDocument.category": CATEGORY
  }
};

let format_record = {
  $project: {
    _id: 0,
    type: { $literal: "resolution" },
    incidentId: "$fullDocument.incidentId",
    fixedAt: { $ifNull: ["$fullDocument.ts", "$clusterTime"] },
    repairStartedAt: "$fullDocument.repairStartedAt",
    resolution: {
      status: { $literal: "resolved" },
      policy: "$fullDocument.policy",
      version: "$fullDocument.version"
    },
    meta: {
      from: { $literal: "fix_events" },
      simRunId: "$fullDocument.simRunId",
      deterministicKey: "$fullDocument.deterministicKey"
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
    // De-dupe by incidentId + type ("resolution")
    on: ["incidentId", "type"],
    whenMatched: "keepExisting",
    whenNotMatched: "insert"
  }
};

let pipeline = [
  fix_events_source,
  match_category,
  format_record,
  write_to_target
];

// sp.process(pipeline);
sp.createStreamProcessor("fix_events_consumer", pipeline);
sp.fix_events_consumer.start();
