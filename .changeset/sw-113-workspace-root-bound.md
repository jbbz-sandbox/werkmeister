---
"werkmeister": patch
---

SW-113: `werkmeister issue`, `notes`, `skills` and `hooks gate` find their workspace by the same rule as `init-workspace`: the folder directly under `paths.workspaces_root` (or `~/workspace`) that holds the current folder. A run with a temp config no longer resolves a real workspace from its current folder, and a command run inside a code worktree resolves the workspace instead of stopping at the worktree's own `.werkmeister/`. Migration: a workspace kept outside those roots is no longer found by these commands; move it under `workspaces_root`, or point `workspaces_root` at its parent with `werkmeister config`. The 03_implement contract's exercise step now says to run a CLI from a temp folder, not only with a temp HOME.
