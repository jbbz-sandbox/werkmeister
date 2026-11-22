---
"werkmeister-core": patch
---

When the capacity hook holds a command because the workspace looks queued, its message now tells the agent to run `werkmeister budget status` and, if that lists the workspace under Running, to rerun the command: the queue entry is stale and the rerun goes through (SW-991). Agents had stopped and asked a person instead. Every path that puts a feature in the capacity queue now writes a `queue.wait` event with a `reason` (`waiting for capacity`, `preempted` or `requeued`), so a stale `waiting.json` can be traced to its writer.
