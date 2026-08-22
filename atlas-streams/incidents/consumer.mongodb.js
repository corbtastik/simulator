// ----- CHANGE THESE TWO PER PROCESSOR -----
const CATEGORY    = "consumer";         // "business" | "consumer" | "federal" | "emerging_tech"
const TARGET_COLL = "consumer_events";  // match the category above
// -----------------------------------------

let incident_events_source = {
  $source: {
    connectionName: "incident-events",
    db: "incidents",
    coll: "incident_events"
  }
};

let match_category = {
  $match: {
    "fullDocument.type": "incident",
    "fullDocument.serviceIssue.category": CATEGORY
  }
};

let format_record = {
  $project: {
    "_id": "$fullDocument._id",
    "incidentId": "$fullDocument._id",
    "city": "$fullDocument.city",
    "lat": "$fullDocument.lat",
    "lng": "$fullDocument.lng",
    "type": "$fullDocument.type",
    "sigmaKm": "$fullDocument.sigmaKm",
    "weight": "$fullDocument.weight",
    "serviceIssue": "$fullDocument.serviceIssue",
    "ts": { $ifNull: [ "$fullDocument.ts", "$clusterTime" ] }
  }
};

let write_to_category = {
  $merge: {
    into: {
      connectionName: "incident-events",
      db: "incidents",
      coll: TARGET_COLL
    }
  }
};

let pipeline = [
  incident_events_source,
  match_category,
  format_record,
  write_to_category
];

// sp.process(pipeline);
sp.createStreamProcessor(TARGET_COLL, pipeline);
sp.consumer_events.start();