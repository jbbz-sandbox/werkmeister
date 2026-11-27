---
"werkmeister-core": patch
---

SW-876: importing the Codex harness no longer calls into `node:child_process` at load, so a test that mocks it without `execFile` can still import it.
