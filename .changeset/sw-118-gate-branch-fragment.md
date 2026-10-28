---
"werkmeister-core": patch
"werkmeister": patch
---

SW-118: the PR gate now tests a branch's own container settings. When the branch's `.werkmeister/services.yaml` renders a touched service differently from the workspace `compose.yml` (a new `environment:` entry, `node_modules_volume`, image, …), `pr gate` / `pr open` start that service from a gate-only `compose.gate.yml` rendered from the branch, run its tests there, then recreate it from `compose.yml` (or stop it, if it wasn't running). Before, the tests ran in containers built from the machine registry, so such changes were never tested.
