---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity queue (SW-686): containers a `--service` or gate start stopped while it waited for capacity now come back through `docker compose up --wait`, in dependency order and with health conditions, instead of one `docker start` per container by name. If they don't all come back, the error names the containers still stopped.
