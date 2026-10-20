---
"werkmeister": patch
---

Ship `LICENSE`, `NOTICE` and `THIRD-PARTY-LICENSES.txt` (the licence text of every package bundled into `dist/`) in the published package. The licence of every npm dependency is now checked against an allowlist in CI (`npm run licenses`); the full inventory is `docs/third-party.md`.
