## Description

The one way to end a workspace. First the post-mortem: it refuses without `postmortem.md` unless `--skip-postmortem` gives a reason. After every PR shipped, it closes the issue, writes `closeout.md`, removes the workspace and deletes merged branches. With `--abandon` and a reason, it records the reason, leaves the issue, pushes every branch and keeps them, and removes the workspace. It lists terminal Claude sessions still open in the workspace.

The full process is in [docs/workspace-lifecycle.md](workspace-lifecycle.md).

## Examples

```bash
werkmeister close-out
werkmeister close-out my-feature --abandon "superseded by SW-200"
```
