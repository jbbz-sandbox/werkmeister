---
"werkmeister-core": minor
"werkmeister": patch
---

Each gate run (`pr gate`, `pr gate --tests`, `pr open`, the MCP `workspace-pr gate`) writes a `gate.start` (run id, `retry`: the workspace's earlier gate runs) and a `gate.end` (run id, `exit`: 0 pass, 75 retry later, 1 failure) to the metrics log under `~/.werkmeister/metrics/`. The run count is kept in the workspace's `.werkmeister/gate-runs`, which `pr open` commits to the record with the gate logs (SW-778).
