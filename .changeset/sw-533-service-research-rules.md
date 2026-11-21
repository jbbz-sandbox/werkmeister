---
"werkmeister-core": patch
"werkmeister": patch
---

The feature research contract now points to each touched service's How-to-validate text, so a research-stage rule there (the harness-adapter recipe, for one) applies before any decision is settled. The werkmeister-core harness recipe also asks to pin the harness version, load a probe plugin that logs every event and tool hook, and capture the `session list` and session-export output shapes (SW-533).
