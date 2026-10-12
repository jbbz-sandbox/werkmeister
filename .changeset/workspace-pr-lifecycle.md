---
"@jbbz-sandbox/sandbox-cli": minor
---

Workspace PR lifecycle (docs/workspace-lifecycle.md): per-repo PR files with an approve flip, `sandbox pr gate|open|status` (pre-PR gate runs the registry test commands, exercise evidence and the repo's release check), a PR-guard hook that blocks `gh pr create` and `/create-pr` inside a workspace, `sandbox close-out`, `remove-workspace --abandon`, a registry `repo:` block for ship detection, and lifecycle state on the workspaces pane. ICM's `ship` stage is now `propose`, and `verify.md` is now `exercise.md`.
