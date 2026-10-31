## Description

Stops a feature's containers without removing them or releasing its slot. Bring it back with `werkmeister feature restart` or `werkmeister feature up`. Use `infra` as the feature name to stop the shared infrastructure.

Two modes run without a person: `--if-idle` is the SessionEnd hook behind a workspace's `auto_stop`, and `--idle` is one pass of the idle reaper over every workspace.

## Examples

```bash
werkmeister feature stop my-feature
werkmeister infra stop
werkmeister internal reap 30
```

## See also

`werkmeister feature down` also releases the slot; `werkmeister feature pause` freezes the containers instead.
