---
"werkmeister": patch
"werkmeister-core": patch
---

New `metrics-trends` MCP tool and `metricsTrends` SDK call (SW-1097): one row per day or week over 7d, 30d, 90d or all, with shipped and abandoned workspaces, minutes per ICM stage (p50, p90), lead time from the first turn to merge and to release, tokens and estimated cost by model, cache-read share, active and wall minutes, and gate runs, minutes and first-pass rate. Every row is also split by werkmeister version (`byVersion`), so a release's effect shows. It reads the metrics event log and `usage.json` already on the machine.
