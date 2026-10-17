---
"@jbbz-sandbox/sandbox-cli": minor
---

Workspaces take an optional `model` (#233): `--model <alias|id>` on `sandbox workspace` / `sandbox init-workspace`, `SANDBOX_MODEL`, `model:` in `workspace.yml`, or the create form's new field. It is written to the workspace's `.claude/settings.json` (a model set there by hand is never overwritten, and clearing `model` removes only the value sandbox wrote), passed as `--model` by `claude-send` and `claude-resume`, and returned by `list-workspaces` / `workspace-status`. Workspaces without a model behave as before.
