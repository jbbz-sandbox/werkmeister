## Description

Regenerates `~/.werkmeister/services.yaml` from every repo's `.werkmeister/services.yaml` fragment under `paths.repos_root`, merged under `~/.werkmeister/services.local.yaml`. It is the same step `werkmeister machine setup` runs, on its own: use it after cloning a new repo. `werkmeister pr status` runs it too when a merged PR changes a fragment and the repo sets `sync_on_merge: auto` ([Ship detection](workspace-lifecycle.md#ship-detection-registry-repo)).

## Examples

```bash
werkmeister registry            # regenerate (sync is the default action)
werkmeister registry --check    # report drift; nonzero exit when stale
```
