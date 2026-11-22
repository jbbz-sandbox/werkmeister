---
"werkmeister": minor
"werkmeister-core": minor
---

`workspaceState` now flags a stalled workspace (SW-1007). `stalled` is `{ reason, since }` or null. A workspace is stalled when the agent reads working but no session file has been written for 30 minutes (`idle`), when it has waited for capacity for more than 30 minutes (`capacity-wait`), or when it shows a `crash-loop` or `session-died` need. A question or approval waiting on a person is not stalled by itself. The new `oldestNeedMs` gives the age of the oldest needs-you item in ms. Both limits are `overrides.stalled_idle_minutes` and `overrides.stalled_wait_minutes` in `~/.werkmeister/config.yaml`, 30 when unset. The MCP `status` tool's output schema lists both fields.
