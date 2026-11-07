---
"werkmeister-core": patch
"werkmeister": patch
---

SW-511: the fixture's fake docker logs a gate `exec` as `exec <container> <row command>`, not the whole argv with the inlined `with-temp-home` script, so `--- docker calls` shows which lint or test command ran.
