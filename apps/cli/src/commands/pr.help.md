## Description

Opens PRs from a workspace and tracks them to a release. Each action:

- `gate` runs the pre-PR gate for each PR file and changes nothing.
- `gate --tests` runs only the gate's lint and test rows, in the workspace container, on each worktree's uncommitted tree (committed, staged, unstaged and untracked changes since its base). It needs no PR file and skips the PR-file, clean, baseline and release rows. It starts a container when none is running and stops it after. The implement stage runs it, so a failure that only happens with the container's env shows up before `pr open`.
- `open` gates, pushes and opens a PR for each PR file at `status: approved`, and records its URL.
- `gate` and `open` check free memory once, before they start a container or run a row: under `budget.free_memory` percent available (default 15), they add a `memory` row, read `retry later (low memory)` and exit 75 without starting anything, since Claude Code stops an idle background gate when the Mac runs low.
- `gate` and `open` don't wait on host load before their checks: the 1-minute load counts the gate's own install and test rows, and the services the gate starts are already admitted against the budget. `--no-wait` is still accepted and does nothing. With tests, a gate can run past a 10-minute tool call: run `pr open` detached, as rule 3 of `_shared/pr-rules.md` shows. `.werkmeister/bin/with-temp-home` runs a shorter wait (up to 90 s) before its command and exits 75 without running it if load is still over (`WERKMEISTER_NO_WAIT=1` skips it). Each service the gate starts waits up to 10 minutes for room in the budget, then fails with `NO_CAPACITY`; one that costs more CPUs or memory than the whole budget fails at once with `NEVER_FITS`, naming its cost and the budget for the first resource over, as does `feature up`. A start that runs a setup service (the install) first waits up to 90 s while the host load is over `budget.host_load` or free memory is under `budget.free_memory`, then fails with `HOST_LOAD`; `WERKMEISTER_NO_WAIT=1` skips that wait, `--no-wait` does not, and on macOS it waits on free memory only. A failed check ends with the host load.
- `status` records merged, shipped or closed from GitHub and the repo's release tags.
- `adopt` records a PR opened outside the workspace.
- `watch` resumes each opening session once its PR merges, ships or closes; `--install` schedules it.
- `new` starts a follow-up PR file and branch for a worktree whose PRs have merged.

Inside a workspace, `gh pr create` (and so `/create-pr`) is blocked by a PreToolUse hook; `werkmeister pr open` is the way to open a PR. The full process (PR files, the gate, ship detection, the PR guard) is in [docs/workspace-lifecycle.md](workspace-lifecycle.md).

## Examples

```bash
werkmeister pr gate
werkmeister pr gate --tests
werkmeister pr open
werkmeister pr status --json
```

## See also

`werkmeister workspace close` ends the workspace once its PRs have shipped.
