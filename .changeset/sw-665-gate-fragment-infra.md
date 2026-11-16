---
"werkmeister-core": patch
---

SW-665: `pr gate` tests every service again when a branch changes an `infrastructure:` or `caches:` entry in the repo's own `.werkmeister/services.yaml` (`every service: … infrastructure: <name>`); since SW-573 such a change touched no service and ran no tests.
