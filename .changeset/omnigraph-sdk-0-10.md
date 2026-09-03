---
'@modernrelay/orbit-omnigraph': minor
---

Omnigraph TS SDK 0.10.

The adapter (and the demo app) now pin `@modernrelay/omnigraph@0.10.0`.
The SDK surface orbit consumes is signature-stable — `export`,
`invokeQuery`, `ingest`, `snapshot`, `schema`, and every type the adapter
imports are unchanged, and the newly exported `ExportRecord` matches the
NDJSON line shape the loader already parses. The SDK-pinned server
generation moves to 0.10, so the version-drift warning now keys off
0.10.x. Recorded test fixtures were regenerated against a real
omnigraph-server 0.10.0 (the fixture recorder also learned the 0.10 CLI
and wire shapes: per-table load counts, snapshot `datasets` entries).
