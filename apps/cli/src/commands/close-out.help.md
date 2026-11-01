## Description

The one way to end a workspace. First the post-mortem: it refuses without `postmortem.md` unless `--skip-postmortem` gives a reason. After every PR shipped, it closes the issue, writes `closeout.md`, removes the workspace and deletes merged branches. `werkmeister workspace abandon "<reason>"` instead records the reason, leaves the issue, pushes every branch and keeps them, and removes the workspace. When the work changed no repo, so there are no PR files, `--no-pr "<reason>"` closes it as done instead: it needs `postmortem.md`, clean code worktrees and no commits ahead of their base, and the reason goes in `closeout.md` and on the issue. It lists terminal Claude sessions still open in the workspace.

The full process is in [docs/workspace-lifecycle.md](workspace-lifecycle.md).

## Examples

```bash
werkmeister workspace close
werkmeister workspace close --no-pr "the fix lives in ~/.claude, outside every repo"
werkmeister workspace abandon "superseded by SW-200" my-feature
```
