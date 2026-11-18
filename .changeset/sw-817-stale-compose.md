---
"werkmeister": patch
"werkmeister-core": patch
---

`with-fixture-workspace --stale-compose` (with `--fragment-change`) inits the workspace before the branch's fragment lands, so `pr gate` starts the service from `compose.gate.yml`; in-process fixtures get `staleCompose` and `applyFragmentChange()` (SW-817).
