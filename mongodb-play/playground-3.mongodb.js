sp.process([
  {
    $source: {
      connectionName: "source-incident-events",
      db: "incidents",
      coll: "incident_events"
    }
  },
  {
    $https: {
      connectionName: "sink-echo-app",                // https://echo-358753871318.us-central1.run.app
      path: "events",
      method: "POST",
      onError: "ignore",
      as: "echoResponse",
      payload: [
        { $project: { from: "asp", ts: "$$NOW", sanity: true } }
      ]
    }
  }
])


// sp.process([
//   { $source: { connectionName: "source-incident-events", db: "incidents", coll: ["incident_events"], config: { pipeline: [{ $match: { operationType: "insert" } }], fullDocument: "required" } } },
//   { $https: {
//       connectionName: "sink-echo-app",
//       path: "events",
//       method: "POST",
//       as: "echoResponse",
//       onError: "ignore",
//       payload: [ { $project: { ping: "from-asp", ts: "$$NOW" } } ]  // <-- guaranteed non-empty
//   } }
// ])

// sp.process([
//   {
//     $source: {
//       connectionName: "source-incident-events",
//       db: "incidents",
//       coll: ["incident_events"],
//       config: {
//         pipeline: [{ $match: { operationType: "insert" } }],
//         fullDocument: "required"
//         // (omit fullDocumentOnly, or set: fullDocumentOnly: true)
//       }
//     }
//   },
//   {
//     $project: {
//       _id: 0,
//       event: "$fullDocument",
//       op: "$operationType",
//       clusterTs: "$clusterTime"
//     }
//   },
//   {
//     $https: {
//       connectionName: "sink-echo-app",          // base: https://echo-358753871318.us-central1.run.app
//       path: "events",
//       method: "POST",
//       onError: "ignore",
//       as: "echoResponse",
//       payload: [
//         { $replaceRoot: { newRoot: "$event" } }  // body = the inserted document
//       ]
//     }
//   },
//   // Optional audit after this:
//   { $merge: { into: { connectionName:"source-incident-events", db:"incidents", coll:"echo_audit" } } }
// ])

// sp.process([
//   {
//     $source: {
//       connectionName: "source-incident-events",
//       db: "incidents",
//       coll: "incident_events",
//       config: {
//         pipeline: [{
//           $match: {
//             operationType: "insert",
//             "fullDocument.type": "incident",
//             "fullDocument.serviceIssue.category": "infrastructure"
//           }
//         }],
//         fullDocument: "required"   // include the full doc on the event
//       }
//     }
//   },

//   // Current doc is the whole change event; pull from fullDocument.*
//   {
//     $project: {
//       _id: 0,
//       serviceIssue: "$fullDocument.serviceIssue",
//       city: "$fullDocument.city",
//       lat: "$fullDocument.lat",
//       lng: "$fullDocument.lng",
//       weight: "$fullDocument.weight",
//       sigmaKm: "$fullDocument.sigmaKm"
//     }
//   },

//   {
//     $https: {
//       connectionName: "sink-echo-app",
//       path: "/events",
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       onError: "ignore",
//       as: "echoResponse"
//     }
//   },

//   {
//     $merge: {
//       into: {
//         connectionName: "source-incident-events",
//         db: "incidents",
//         coll: "infrastructure"
//       }
//     }
//   }
// ]);

// sp.process([
//   {
//     $source: {
//       connectionName: "source-incident-events",
//       db: "incidents",
//       coll: "incident_events",
//       config: {
//         pipeline: [{
//           $match: {
//             operationType: "insert",
//             "fullDocument.type": "incident",
//             "fullDocument.serviceIssue.category": "infrastructure"
//           }
//         }],
//         fullDocument: "required"   // include the full doc on the event
//       }
//     }
//   },

//   // Current doc is the whole change event; pull from fullDocument.*
//   {
//     $project: {
//       _id: 0,
//       serviceIssue: "$fullDocument.serviceIssue",
//       city: "$fullDocument.city",
//       lat: "$fullDocument.lat",
//       lng: "$fullDocument.lng",
//       weight: "$fullDocument.weight",
//       sigmaKm: "$fullDocument.sigmaKm"
//     }
//   },

//   {
//     $https: {
//       connectionName: "sink-echo-app",
//       path: "/events",
//       method: "POST",
//       onError: "ignore",
//       as: "echoResponse"
//     }
//   },

//   {
//     $merge: {
//       into: {
//         connectionName: "source-incident-events",
//         db: "incidents",
//         coll: "infrastructure"
//       }
//     }
//   }
// ]);
