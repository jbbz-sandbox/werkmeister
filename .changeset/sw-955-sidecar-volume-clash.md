---
"werkmeister-core": patch
---

Compose generation refuses a sidecar's named volume that another container in the feature also mounts: a bare `extra_volumes` name is one `<feature>-<name>` volume, so two postgres sidecars naming `pgdata` ran on one data dir. The error names the volume and every container mounting it; give each sidecar's volume its own name. Services and setup services still share a named volume, as caches do (SW-955).
