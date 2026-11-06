---
"werkmeister": patch
---

New `werkmeister machine tokens` lists the daemon tokens in `~/.werkmeister/tokens` that have no workspace folder; `--remove` deletes them (SW-446). Before SW-433 (0.74.0), core tests left tokens there named `create-copy-ws-*`, `jit-snap-ws-*`, `record-init-*`, `switch-init-ws*`, `init-registry-*`, `init-branch-fragment-*`, `mcp-ws-*`, `create-default-*` and `create-origin-*`; run `werkmeister machine tokens --remove` once to clear them.
