---
"werkmeister": patch
---

`registry sync`'s warning for a forwarded service with no `health_endpoint` also names the other fix: set it to `/health` to keep the probe, or `""` for a non-HTTP service (SW-1082).
