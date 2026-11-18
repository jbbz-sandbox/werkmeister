---
"werkmeister-core": patch
---

Autonomous workspaces narrow two CLI rules that reached past the workspace. `werkmeister pr:*` becomes `pr gate|open|status|new|adopt`, so `pr watch` (whose `--install` writes a launchd job) asks. `workspace init:*`/`init-workspace:*` become the bare form plus `--refresh-issue`, `--prune-context` and `--labels focus`, so `--feature <other>`, `--repos`, `--force` and `--autonomous` ask. Autonomous mode also denies Edit on `.env*`, `.werkmeister/workspace.yml`, `.werkmeister/claude-permissions.json` and `.werkmeister/token`, which the next wake's rules are read from (SW-625).
