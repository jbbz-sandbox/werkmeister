---
"werkmeister": patch
"werkmeister-core": patch
---

`werkmeister issue start` now writes an `issue.start` metrics event when it moves an issue to In Progress, and the `metrics` tool starts cycle time at a workspace's earliest `issue.start`, falling back to its first turn (SW-1034). Each ticket row gains `inProgressAt`, the start it used, or null on the fallback. Lead time still starts at the first turn.
