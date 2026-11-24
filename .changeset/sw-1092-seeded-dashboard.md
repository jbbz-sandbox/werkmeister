---
"werkmeister": minor
"werkmeister-core": minor
---

SW-1092: `werkmeister workspace serve --dashboard` serves the workspace's werkmeister worktree's built dashboard (`apps/cli/dist/dashboard.js`, no host install) for a stage 03 browser check. It runs on 127.0.0.1 under a fresh temp HOME seeded with a workspace in each lifecycle state, transcripts and a metrics event log, with an env built from nothing: docker, the Terminal/VS Code launcher, `claude`, `code`, `kubectl`, `gh` and `werkmeister` are stubs that log to `side-effects.log`, and `DOCKER_HOST` and the daemon address are dead. The werkmeister-dashboard Validation text names it; run `werkmeister registry sync` to pick that up. New core export `werkmeister-core/dashboard_seed`.
