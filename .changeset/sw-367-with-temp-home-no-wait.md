---
"werkmeister": patch
---

`.werkmeister/bin/with-temp-home --no-wait <cmd>` skips the host-load wait without an env assignment, so the agent keeps its one permission rule; the generated allow rules and werkmeister-context.md cover the flag. `WERKMEISTER_NO_WAIT=1` still works. Run `werkmeister migrate` to refresh an existing workspace's wrapper and rules (SW-367).
