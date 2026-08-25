---
'@modernrelay/orbit-core': minor
'@modernrelay/orbit-react': minor
---

First-load feel: the settle camera and simulation presets.

Two measured problems on every fresh force-layout mount: the first-data fit
frames the seed ring while the simulation contracts the graph to 5–17% of
that frame (a distant blob), and the engine's default cooling keeps visible
motion alive for tens of seconds (reads as endless jitter).

- **Settle camera** — new `fitViewOnSettle` option (`'follow'` (default) |
  `'once'` | `false`). Under `'follow'` the camera keeps the settling graph
  framed with periodic animated refits riding the engine frame fan-out (no
  timers, no extra rAF) and a final fit at first quiescence; any user camera
  input cancels it. `'once'` fits a single time at quiescence; `false`
  restores the previous behavior.
- **Simulation presets** — `simulation` now also accepts a preset name:
  `'calm'`, `'spread'`, `'tight'`, or `'lively'` (`SIMULATION_PRESETS` and
  `resolveSimulation` are exported). Presets were selected on a measured
  protocol: seconds until sustained visible stillness on an 800-node
  clustered graph.
- **Default changed**: an omitted `simulation` now resolves to the `'calm'`
  preset (visually still in ~5s) instead of the engine's own defaults. The
  old feel is one prop away: `simulation="lively"`.
