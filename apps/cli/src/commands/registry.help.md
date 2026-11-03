## Description

Regenerates `~/.werkmeister/services.yaml` from every repo's `.werkmeister/services.yaml` fragment under `paths.repos_root`, merged under `~/.werkmeister/services.local.yaml`. It is the same step `werkmeister machine setup` runs, on its own: use it after cloning a new repo. `werkmeister pr status` runs it too when a merged PR changes a fragment and the repo sets `sync_on_merge: auto` ([Ship detection](workspace-lifecycle.md#ship-detection-registry-repo)).

To prove a fragment change before it merges, `--from <worktree>` takes that checkout's `.werkmeister/services.yaml` in place of its repo's fragment under `paths.repos_root`, and `--out <file>` writes the merged registry there instead of `~/.werkmeister/services.yaml` (which is never touched, nor is `services.local.yaml` seeded). `--check` compares against `--out` the same way.

## Examples

```bash
werkmeister registry            # regenerate (sync is the default action)
werkmeister registry --check    # report drift; nonzero exit when stale
werkmeister registry --from ./werkmeister --out /tmp/services.yaml          # branch fragment, temp registry
werkmeister registry --check --from ./werkmeister --out /tmp/services.yaml  # is that file current?
```
