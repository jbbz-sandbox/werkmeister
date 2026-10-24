---
"werkmeister-core": patch
---

The PR gate's on-demand service start no longer aborts a cold workspace with `docker compose failed (exit 130)` (SW-86). The 300 s compose timeout was firing while `up -d --wait <svc>` waited on the setup container's install and build. Compose catches the timeout's SIGTERM and exits 130, which `runAsync` took for an ordinary exit. `runAsync` now reports any kill by its own timer as a timeout. `sandbox up` and the gate's service start get a 20-minute budget, and the timeout message states the real budget. A failed start also names the state the container was left in, e.g. `Failed to start cli (left created)`.
