---
"@modernrelay/orbit-core": minor
"@modernrelay/orbit-data": minor
"@modernrelay/orbit-react": patch
"@modernrelay/orbit-engine-cosmos": patch
---

Add bounded, cancellable graph preparation with progress notifications and a CSV preview helper. All preparation formats now support optional columnar output while retaining object snapshots as the default and preserving the v1 artifact format.

Expose live overview subscriptions and share a bounded position cache between labels and the minimap. Cosmos uses asynchronous position reads for scenes up to 10,000 nodes when available and a conservative synchronous cadence for larger scenes, rejects stale results after graph or engine changes, and stops sampling at rest.

Add a guided CSV import flow to the demo and a complete first-graph quickstart verified against packed packages.
