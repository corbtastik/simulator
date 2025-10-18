use('incidents');
db.incident_events.countDocuments();
// db.incident_events.find({"city.name": "Monrovia"})
// db.incident_events.distinct("serviceIssue.type");
db.incident_events.findOne({
  city: "Mideland",
  "serviceIssue.type": "fiber-consturction"
});
db.incident_events.insertOne({
  type: "incident",
  city: "Midland",
  ts: new Date(),
  lat: 31.61,
  lng: -102.11,
  weight: 4,
  sigmaKm: 10,
  serviceIssue: {
    category: "infrastructure",
    type: "fiber-consturction",
    projectId: "FBR-MID-714",
    issue: "splice-crew-shortage",
    city: "Midland",
    contractoru: "Hedgehog Fiber"
  }
})