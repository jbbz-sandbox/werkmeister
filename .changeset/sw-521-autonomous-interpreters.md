---
"werkmeister": patch
---

SW-521: autonomous workspaces no longer pre-approve `node`, `npx`, `pnpm exec` or `python3`, which ran any file (one the agent just wrote included) with the real HOME, and they deny `node` and `python3` outright, so a registered test chain's bare `node --test` segment can't run an arbitrary file either. Headless runs test through the registered `with-temp-home <test command>` and container forms. `werkmeister machine migrate` now refreshes a workspace whose settings still hold a rule werkmeister no longer generates, so existing autonomous workspaces drop the old rules.
