## Description

Opens PRs from a workspace and tracks them to a release. Each action:

- `gate` runs the pre-PR gate for each PR file and changes nothing.
- `open` gates, pushes and opens a PR for each PR file at `status: approved`, and records its URL.
- Before each gate check (lint, tests, release), `gate` and `open` wait while the host's 1-minute load is above `budget.host_load` in `~/.werkmeister/config.yaml` (default: 2 × CPUs; `0` turns it off), for up to 10 minutes in all across the run, saying up front how long they may wait and printing progress each minute, then run anyway. `--no-wait` skips the wait. With tests on top, a gate under load can run well past a 10-minute tool call: run `pr open` detached, as rule 3 of `_shared/pr-rules.md` shows. `.werkmeister/bin/with-temp-home` runs the same wait before its command (`WERKMEISTER_NO_WAIT=1` skips it). A failed check ends with the host load.
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

`werkmeister workspace close` ends the workspace once its PRs have shipped.
