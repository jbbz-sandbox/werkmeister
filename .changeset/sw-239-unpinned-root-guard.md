---
"werkmeister-core": patch
---

SW-239: under `node --test`, `sandboxRoot()` (and so `monorepoRoot()`) throws unless the test called `pinWerkmeisterRoot()`, so a new core test can no longer depend on the unpinned root. Outside a test run nothing changes.
