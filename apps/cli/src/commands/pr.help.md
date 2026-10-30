## Description

Opens PRs from a workspace and tracks them to a release. Each action:

- `gate` runs the pre-PR gate for each PR file and changes nothing.
- `open` gates, pushes and opens a PR for each PR file at `status: approved`, and records its URL.
- Before each gate check (lint, tests, release), `gate` and `open` wait while the host's 1-minute load is above `budget.host_load` in `~/.werkmeister/config.yaml` (default: 2 × CPUs; `0` turns it off), for up to 30 minutes, then run anyway. `--no-wait` skips the wait. `.werkmeister/bin/with-temp-home` runs the same wait before its command (`WERKMEISTER_NO_WAIT=1` skips it). A failed check ends with the host load.
- `status` records merged, shipped or closed from GitHub and the repo's release tags.
- `adopt` records a PR opened outside the workspace.
- `watch` resumes each opening session once its PR merges, ships or closes; `--install` schedules it.
- `new` starts a follow-up PR file and branch for a worktree whose PRs have merged.

Inside a workspace, `gh pr create` (and so `/create-pr`) is blocked by a PreToolUse hook; `werkmeister pr open` is the way to open a PR. The full process (PR files, the gate, ship detection, the PR guard) is in [docs/workspace-lifecycle.md](workspace-lifecycle.md).

## Examples

```bash
werkmeister pr gate
werkmeister pr open
werkmeister pr status --json
```

## See also

`werkmeister close-out` ends the workspace once its PRs have shipped.
