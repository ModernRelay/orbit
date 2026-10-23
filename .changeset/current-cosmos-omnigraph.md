---
'@modernrelay/orbit-engine-cosmos': minor
'@modernrelay/orbit-omnigraph': minor
---

Upgrade Cosmos to 3.5.0 and OmniGraph to 0.14.0. Both adapters now require Node.js 22 or newer.

The Cosmos adapter resolves the compatible Luma 9.3 peers and uses flat position snapshots. The OmniGraph adapter follows the 0.14 HTTP contract, reads physical IDs separately from user properties, normalizes nullable and UTC temporal values, and preserves search cancellation. Generated OmniGraph attribute types no longer inject a physical `id`; schema-declared `id` properties retain their declared types, and list types account for nullable elements. Regenerate generated types and update stored-query column mappings for the new result format when upgrading.

Upgrade OmniGraph servers alongside the SDK; the 0.13 HTTP contract is no longer accepted. Export drift checks now read the captured head from bounded commit-history pages, preserving revision checks without fetching the entire history. Integration fixtures and CI use the official 0.14.0 server.
