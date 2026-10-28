---
"werkmeister-core": minor
---

Workspaces ship a temp-HOME test wrapper (SW-124). `init-workspace` writes `.werkmeister/bin/with-temp-home <cmd…>`, which runs a command with a fresh `mktemp -d` HOME and removes it on exit (keeping corepack's cache, so pnpm isn't re-downloaded). `werkmeister-context.md` states each host test command through it, the allow rules pre-approve the wrapped form, and the ICM test step tells agents, and the subagents they brief, to run every test command through it.
