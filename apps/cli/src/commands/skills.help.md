## Description

Keeps a workspace's context layer fresh. `check` renders it again and diffs that with what is on disk, exiting 1 with a per-entry report when anything is stale. `sync` rewrites whatever `check` reports. What counts as the context layer depends on the workspace's strategy: for jit, the w9r-* skills in `.claude/skills/` and the gate manifest; for icm, `_shared/standards.md` and the stage contracts.

Run it from anywhere inside a workspace.

## Examples

```bash
werkmeister skills check
werkmeister skills sync
```

## Exit codes

0 when fresh (or synced), 1 when `check` finds drift.
