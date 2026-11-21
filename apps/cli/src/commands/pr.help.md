## Description

Opens PRs from a workspace and tracks them to a release. Each action:

- `gate` runs the pre-PR gate for each PR file and changes nothing.
- `gate --tests` runs only the gate's lint and test rows, in the workspace container, on each worktree's uncommitted tree (committed, staged, unstaged and untracked changes since its base). It needs no PR file and skips the PR-file, clean, baseline and release rows. It starts a container when none is running and stops it after. The implement stage runs it, so a failure that only happens with the container's env shows up before `pr open`.
- `open` gates, pushes and opens a PR for each PR file at `status: approved`, and records its URL.
- `push` force-pushes each open PR's branch after a rebase (rule 5's conflict fix), with `--force-with-lease=<branch>:<sha>` where `<sha>` is the PR file's `conflict_head:`, the PR head `pr watch`'s conflict wake saw (never `origin/<branch>` as fetched, which a fetch moves onto a reviewer's commit); after the push it records the pushed head there. It refuses, pushing nothing for that PR, unless the PR file names one of the workspace's own worktrees (a worktree of a repo under the repos root; no git runs before this check, and a standalone clone, whose git config sits in the workspace, is refused), the branch is the workspace's own (`<user>/<workspace>`, or a `pr new` follow-up once that PR settled) and checked out, the worktree is clean, the branch holds no merge commit from its base, the PR file has a `conflict_head:`, origin's branch is still that head, and the local branch once held it (its reflog), so a commit pushed before the conflict is never dropped. ICM workspaces pre-approve it.
- `gate` and `open` check free memory once, before they start a container or run a row: under `budget.free_memory` percent available (default 15), they add a `memory` row, read `retry later (low memory)` and exit 75 without starting anything, since Claude Code stops an idle background gate when the Mac runs low.
- `gate` and `open` don't wait on host load before their checks: the 1-minute load counts the gate's own install and test rows, and the services the gate starts are already admitted against the budget. `--no-wait` is still accepted and does nothing. With tests, a gate can run past a 10-minute tool call: run `pr open`, and `pr gate` or `pr gate --tests`, as a background job with its log, as rule 3 of `_shared/pr-rules.md` shows. `.werkmeister/bin/with-temp-home` runs a shorter wait (up to 90 s) before its command and exits 75 without running it if load is still over (`WERKMEISTER_NO_WAIT=1` skips it). The services a gate starts wait for room in the budget up to 30 minutes in all, keeping their place in the queue, then fail with `NO_CAPACITY`; one that costs more CPUs or memory than the whole budget fails at once with `NEVER_FITS`, naming its cost and the budget for the first resource over, as does `feature up`. A start that runs a setup service (the install) first waits up to 90 s while the host load is over `budget.host_load` or free memory is under `budget.free_memory`, then fails with `HOST_LOAD`; `WERKMEISTER_NO_WAIT=1` skips that wait, `--no-wait` does not, and on macOS and Windows the load is the Docker VM's. A failed check ends with the host load. A test row killed with exit 137, or whose only error is vitest's worker RPC timeout (`Timeout calling "onTaskUpdate"`, a worker blocked past vitest's fixed 60 s), is run once more, after the same host-load wait `with-temp-home` runs, and says it was retried; it fails only if the retry fails too.
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
