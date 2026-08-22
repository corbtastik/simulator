# Atlas Stream Processors

MongoDB Atlas Stream Processor pipeline definitions for the incident simulation system.

## Directory Structure

```
atlas-streams/
├── incidents/        # Route incidents from incident_events to category collections
├── fix-events/       # Route fix events (resolutions) to category collections
└── repair-started/   # Route repair_started events to category collections
```

## Pipelines

### incidents/
Routes incidents from `incident_events` to category-specific collections based on `serviceIssue.category`:
- `business.mongodb.js` → `business_events`
- `consumer.mongodb.js` → `consumer_events`
- `emerging_tech.mongodb.js` → `emerging_tech_events`
- `federal.mongodb.js` → `federal_events`
- `infrastructure.mongodb.js` → `infrastructure_events`

### fix-events/
Routes resolution events from `fix_events` (type: "fix") to category collections:
- Matches on `type: "fix"` and `category`
- Outputs documents with `type: "resolution"`

### repair-started/
Routes repair start events from `fix_events` (type: "repair_started") to category collections:
- Matches on `type: "repair_started"` and `category`
- Includes `expectedFixAt` for animation timing

## Deployment

Run each `.mongodb.js` file in the MongoDB VSCode extension or Atlas UI to create/start the stream processors.

### Prerequisites
- Unique index on category collections: `{ incidentId: 1, type: 1 }`
- Connection named `fix-events` or `incident-events` configured in Atlas Streams

## Data Flow

```
incident_events ──[incidents/*]──▶ *_events (type: "incident")

fix_events ──[repair-started/*]──▶ *_events (type: "repair_started")
           ──[fix-events/*]──────▶ *_events (type: "resolution")
```
