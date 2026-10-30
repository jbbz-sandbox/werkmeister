## Description

Reconciles a workspace from its `.werkmeister/workspace.yml` and regenerates its context files. It adds a git worktree for each repo the config needs (its `repos` plus the repos owning its `services`) and removes worktrees for repos it dropped; a dirty worktree stops the run unless `--force`. Then it writes CLAUDE.md, `.env`, `compose.yml`, the `.claude/` skills and agents, `.mcp.json` and `.werkmeister/*`.

It is idempotent: edit `workspace.yml` and rerun. It never prompts, and refuses to run in a bare folder; create a workspace with `werkmeister workspace`.

## Examples

```bash
werkmeister init-workspace
werkmeister init-workspace --services backend,frontend
werkmeister init-workspace --refresh-issue
```
