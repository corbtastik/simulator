// Sets the source of the records to the incident_events collection in the incidents database, which is where the simulator writes events.
// This will set change streams of inserted, updated, and deleted records to be the source of the stream processor
let incident_events_source = {
    $source: {
        connectionName: "source-incident-events",
        db: "incidents",
        coll: "incident_events"
    }
};

// We can filter the records to only those that are of type "incident" and category "infrastructure".
let match_infrastructure_incident_events = { $match: { "fullDocument.type": "incident", "fullDocument.serviceIssue.category": "infrastructure" }};

// We use $project to format the records that we will write
let format_record = {
    $project: {
        "_id": "$fullDocument._id",                     // <-- KEY LINE
        "incidentId": "$fullDocument._id",              // optional if you want both        
        "city": "$fullDocument.city",
        "lat": "$fullDocument.lat",
        "lng": "$fullDocument.lng",
        "sigmaKm": "$fullDocument.sigmaKm",
        "weight": "$fullDocument.weight",
        "serviceIssue": "$fullDocument.serviceIssue",
        "ts": { $ifNull: [ "$fullDocument.ts", "$clusterTime" ] } // nice to have for debugging/order
    }
};

// We write the records to the infrastructure collection so that they can be reviewed by the infrastructure operations team
let write_to_infrastructure_collection = {
    $merge: {
        into: {
            connectionName: "source-incident-events",
            db: "incidents",
            coll: "infrastructure_events"
        }
    }
};

// Create an array of stages that the stream processor will run
let pipeline = [
    incident_events_source,
    match_infrastructure_incident_events,
    format_record,
    write_to_infrastructure_collection
]

sp.process(pipeline);