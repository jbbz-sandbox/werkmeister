---
"werkmeister-core": patch
---

`machine migrate` now rewrites a workspace's `with-temp-home` wrapper whenever it differs from the one this CLI writes, even when the workspace's hooks and permission rules are already current. `machine migrate --check` reports such a workspace as stale (SW-416).
