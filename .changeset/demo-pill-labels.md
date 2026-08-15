---
'orbit-demo': patch
---

Demo: node labels render as pills with a show/hide-type toggle.

Labels were a flat `"Kind · Name"` string in uniform white with `nowrap` and no
width cap, so the kind prefix competed with the name and long titles ran ~600px
and overlapped into a wall of text on a dense graph.

They now render through `<Graph renderNodeLabel>` as a pill: a themed scrim that
separates each label from the node cloud behind it, a width clamp with an
ellipsis, and the kind demoted to a small dimmed uppercase prefix that the Style
panel can hide entirely. Colours read the existing `themeVars` custom properties
rather than hardcoded rgba, so the pill follows the dark/light toggle.

The toggle is **visual only** — `labelOf` still returns the full `"Kind · Name"`
for `LabelConfig.getText` and `AccessibilityConfig.getAccessibleLabel`, so the
navigator, live region, tooltip and hover readout always carry the kind and a
screen-reader user never loses the disambiguation.
