---
"werkmeister-core": patch
---

The PR gate's on-demand start no longer asks compose for a service id only the branch registry knows: when a branch has renamed a service (e.g. `sandbox-core` → `werkmeister-core`) but the machine registry, and so `compose.yml`, still uses the old id, the gate starts the compose service that owns the same path, tests through it, and notes the drift with a pointer to `werkmeister registry` (SW-87).
