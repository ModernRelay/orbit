---
"@modernrelay/orbit-core": patch
"@modernrelay/orbit-data": patch
"@modernrelay/orbit-engine-cosmos": patch
"@modernrelay/orbit-omnigraph": patch
"@modernrelay/orbit-react": patch
---

Prevent stale worker results and view restores from replacing newer datasets,
preserve saved layouts before mounting, and restore scale domains and fold
counts during undo. Visible exports now respect edge filters.

Fix table filtering after empty results and refresh navigator and tooltip
content when the scene changes. Keep fit-view zoom limits effective during
position transitions.

Normalize nested Arrow values and Omnigraph temporal lists, honor cancellation
through the final ingestion boundary, and avoid collisions between generated
node and edge type names.
