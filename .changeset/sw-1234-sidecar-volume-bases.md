---
"werkmeister-core": patch
---

`machine clean` now finds an orphaned `extra_services` sidecar volume (a removed feature's `<feature>-pgdata`), and removes a per-feature volume only when that feature's compose project created it, so another project's `myapp-pgdata` is never deleted (SW-1234).
