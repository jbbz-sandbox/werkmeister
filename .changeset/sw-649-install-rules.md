---
"werkmeister-core": patch
"werkmeister": patch
---

SW-649: an autonomous workspace pre-approves the exact frozen install each of its repos' root lockfiles pins (pnpm, npm, yarn v1, yarn berry with `.yarnrc.yml`, uv) instead of always the fixed npm and pnpm pair. The lockfiles are read from the repo's checkout under `repos_root`, not the workspace's worktree, so a lockfile an agent writes grants nothing. A repo with none of these lockfiles gets no install rule.
