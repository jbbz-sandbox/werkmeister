---
"werkmeister": patch
---

A background test or tool run past 30 minutes keeps reading as working for preemption and `feature pause`, as it already did on the workspace card: both now keep a background shell for `stalled_tool_minutes` plus 30 minutes (SW-1058).
