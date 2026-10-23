---
"werkmeister-vscode": patch
---

Ship `LICENSE`, `NOTICE` and `THIRD-PARTY-LICENSES.txt` (the licence text of every package inlined into `extension.cjs`) in the .vsix, so vsce no longer warns "LICENSE not found" (SW-74). The extension build now shares `scripts/write-licenses.mjs` with `apps/cli`.
