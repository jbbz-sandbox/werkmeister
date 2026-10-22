---
"werkmeister": minor
---

A services-registry `extra_volumes` entry can now name one Docker volume that every feature shares: write it with a leading `^` (`^sandbox-pnpm-store:/pnpm-store`). Each feature's compose mounts it unprefixed and declares it `external`, and `sandbox up` creates it if it is missing, so a package-manager store or cache is warm in every workspace. No feature's `down --volumes`, close-out or `clean` removes it; drop it with `docker volume rm <name>`. Bare names stay per-feature (`<feature>-<name>`).
