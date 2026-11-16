---
"werkmeister": patch
"werkmeister-core": patch
---

`pr gate` / `pr open` (SW-744): a test row whose only error is vitest's worker RPC timeout (`Timeout calling "onTaskUpdate"`, a worker blocked past vitest's fixed 60 s under host load) is run once more after the host-load wait, like an exit 137, and its row says it was retried. A real failure beside it (a failed test, a type error) still fails with no retry. The CLI's own tests start the bundled CLI and scripts asynchronously, so they no longer block a worker that long.
