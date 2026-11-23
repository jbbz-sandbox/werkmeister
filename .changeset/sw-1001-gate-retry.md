---
"werkmeister": patch
---

`gate.start`'s `retry` counts reruns per PR file, so in a multi-repo or grouped workspace the first `pr gate` writes `retry 0` for every repo, not 0, 1, 2…. The counts live in `.werkmeister/gate-runs-<pr file>`, which `pr open` commits to the record with the gate logs, along with an older workspace's single `gate-runs` (SW-1001).
