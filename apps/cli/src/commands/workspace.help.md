## Description

Creates a new workspace under the workspaces root and initializes it. It resolves its inputs (flags, an existing `workspace.yml`, or the interactive wizard), creates the workspace folder as a git worktree of the workspace record repo (`overrides.workspace_repo`) on a `user/workspace` branch, writes `.werkmeister/workspace.yml`, and runs `werkmeister workspace init` inside it. The initial state is committed, not pushed.

## Examples

```bash
werkmeister workspace new my-feature --issue-id SW-180 --services backend,frontend
werkmeister workspace new my-feature --context-strategy icm --work-type refactor
```

## See also

`werkmeister workspace init` owns everything derived from `workspace.yml`; `werkmeister workspace close` ends a workspace.
