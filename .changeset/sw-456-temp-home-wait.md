---
"werkmeister": patch
---

SW-456: killing the generated `with-temp-home` while it waits for host load now ends its `werkmeister internal wait-load` too, instead of leaving it polling for up to 10 min. The generated werkmeister-context.md says that a `with-temp-home` call with no output and only `wait-load` under it is that wait, not a hang, and that `--no-wait` skips it. A workspace gets the new wrapper and text the next time `werkmeister workspace init` runs in it.
