---
'@modernrelay/orbit-engine-cosmos': minor
'@modernrelay/orbit-omnigraph': minor
'@modernrelay/orbit-react': patch
'@modernrelay/orbit-data': patch
'@modernrelay/orbit-core': patch
---

Upgrade Cosmos to 3.5.1 and OmniGraph to 0.14.0. Both adapters now require Node.js 22 or newer.

The Cosmos adapter resolves the compatible Luma 9.3 peers and uses flat position snapshots. The OmniGraph adapter follows the 0.14 HTTP contract, reads physical IDs separately from user properties, normalizes nullable and UTC temporal values, and preserves search cancellation. Generated OmniGraph attribute types no longer inject a physical `id`; schema-declared `id` properties retain their declared types, and list types account for nullable elements. Regenerate generated types and update stored-query column mappings for the new result format when upgrading.

Upgrade OmniGraph servers alongside the SDK; the 0.13 HTTP contract is no longer accepted. Export drift checks now read the captured head from bounded commit-history pages, preserving revision checks without fetching the entire history. Integration fixtures and CI use the official 0.14.0 server.

Refresh dependencies across all packages and apps, including React 19.3, Vite 8, Storybook 10.6, Vitest 5, jsdom 30, Playwright 1.64, and TypeScript 7. React 18 remains supported. The root retains TypeScript 6 for build tools that require its compiler API, and Luma stays on the latest 9.3 patch required by Cosmos. Development uses pnpm 12 and Node.js 22.18+, 24.11+, or 26+.
