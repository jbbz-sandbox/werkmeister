---
"werkmeister": patch
---

Workspaces' generated Claude Code permissions now allow pnpm's build and test commands (`pnpm install --frozen-lockfile`, `pnpm run`, `pnpm test`, `pnpm exec`, `pnpm turbo`) and deny `pnpm publish`, `pnpm link` and global pnpm installs, as they already did for npm. The werkmeister repo itself now builds with pnpm; installing the CLI (`npx werkmeister setup`, `npm install -g werkmeister`) is unchanged.
