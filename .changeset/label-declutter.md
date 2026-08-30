---
'@modernrelay/orbit-core': minor
---

Label declutter: screen-space overlap culling, on by default.

Dense clusters used to stack their top-ranked labels into an unreadable
pile — the selector ranked and viewport-culled but never checked where
labels land on screen. Ranked selection now runs a greedy occupancy pass in
rank order: a candidate whose estimated label box intersects an
already-placed label loses its slot to the next-ranked candidate. `showFor`
ids always render and claim their space first. New `LabelConfig` fields:
`overlap: 'hide' (default) | 'allow'` and `overlapPadding` (px, default 2).
Boxes are fixed-per-character estimates — decluttering, not typesetting —
and selection stays overlap-blind when the viewport cannot project.
Note for FakeEngine-based tests: the double projects identity coordinates,
so decluttering engages there too — suites that pin label sets over
tightly-packed fixtures should opt out with `overlap: 'allow'` (this
repo's scheduling-focused suites now do).
