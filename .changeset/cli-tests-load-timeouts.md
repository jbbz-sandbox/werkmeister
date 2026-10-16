---
---

Test-only: give the sandbox-cli suite a 60 s test/hook timeout, spawn the built CLI instead of a cold tsx in the completion and `up` flag tests, and drop mcp_bundle.test.ts's inner 10 s deadline, so the suite stops timing out on a busy host (#206). Nothing ships.
