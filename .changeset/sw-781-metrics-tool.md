---
"werkmeister": minor
"werkmeister-core": minor
---

New `metrics` MCP tool (SW-781), and `metricsReport` on `werkmeister-core/sdk`: for a range of `7d` (the default), `30d`, `90d` or `all`, it returns the flow board of open workspaces (working with its ICM stage, ready, pr-open, awaiting release), each card's age and current wait, each column's age p50/p90, waits by cause per week (person, capacity, PR open → merge, gate retries, release), cycle and lead time per ticket, and cost, tokens, active and wall time, turns and gate first-pass rate. It reads the metrics event log, each workspace's state and `usage.json` from the workspace record branches already on this machine; it never fetches. Cycle time starts at the workspace's first turn.
