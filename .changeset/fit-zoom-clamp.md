---
'@modernrelay/orbit-core': minor
'@modernrelay/orbit-engine-cosmos': minor
'@modernrelay/orbit-react': minor
---

Fit zoom clamp: small graphs no longer balloon.

Measured: a 60-node graph fit at zoom 4.3 (nodes render as balloons), 300
nodes at 3.3. Every internally issued fit (first-data fit, settle follow,
public `fitView`) now carries a zoom upper bound — new `fitViewMaxZoom`
option, default 1.5, `null` to disable. The engine contract's
`FitViewOptions` gains `maxZoom`; when the natural fit zoom exceeds the
bound, the cosmos engine centers the scene bbox at the bound with one
animated transform instead. Verified live: small-graph fits land at exactly
1.5 (previously 3.1–4.3).
