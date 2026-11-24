---
"werkmeister": minor
---

The dashboard has a Metrics tab (SW-1098), after Flow: 7d / 30d / 90d / All range buttons (30d by default) that call `metrics-trends` once per change, a version filter over each row's `byVersion` (no extra call), stat tiles (shipped, abandoned, est. cost, gate first pass) and preview charts drawn with new dependency-free inline-SVG primitives (a line with a p50–p90 band, a stacked bar, a heatmap, a stat tile). A range with no activity shows an empty state. The stage, token and test charts that replace the previews follow in SW-1099–1101.
