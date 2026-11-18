---
"werkmeister": patch
"werkmeister-core": patch
---

Templates and workspace skills are read from the checkout the code runs from when `WERKMEISTER_ROOT` is only config.yaml's `paths.werkmeister_root` (the value env.sh exports into every shell), so a workspace worktree's build renders its own templates. The daemon, Caddy and shared-infra paths still follow `WERKMEISTER_ROOT`, and any other value still wins everywhere.
