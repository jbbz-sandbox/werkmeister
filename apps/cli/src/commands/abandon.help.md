## Description

Ends a workspace whose work won't ship: superseded, out of scope, or stopped. Like `werkmeister workspace close`, it refuses without `postmortem.md` unless `--skip-postmortem` gives a reason. Then it records the reason in `closeout.md` and the PR files, pushes every code branch that has commits of its own and keeps it, and removes the workspace. On the issue it posts `Abandoned, not shipped: <reason>`, plus the branch that holds `postmortem.md` when there is one, and moves it to the `abandoned` status (on Jira Done by default; on GitHub closed as not planned; see [Issue status](workspace-lifecycle.md#issue-status)). With `--keep-open` the issue goes back to To Do (GitHub: left open, comment only) instead, for work parked to retry later. Use `werkmeister workspace close` instead once every PR has shipped, or with `--no-pr` when the work changed no repo. It lists terminal Claude sessions still open in the workspace.

The full process is in [docs/workspace-lifecycle.md](workspace-lifecycle.md).

## Examples

```bash
werkmeister workspace abandon "superseded by SW-200"
werkmeister workspace abandon "superseded by SW-200" my-feature
werkmeister workspace abandon "blocked on SW-210; retry after it ships" --keep-open
```
