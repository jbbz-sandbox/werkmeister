---
"werkmeister-core": patch
---

`pr gate` matches a failed node:test case by its line shape (`not ok N`, with turbo's `<pkg>:<task>: ` prefix), not by the bare words "not ok". A passing test whose name holds "not ok" no longer blocks the SW-744 retry of a row whose only error is vitest's worker RPC timeout, and the failing-test lines above a red row's tail leave such passes out (SW-1230).
