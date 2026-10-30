## Description

Stops a feature's containers without removing them or releasing its slot. Bring it back with `werkmeister restart` or `werkmeister up`. Use `infra` as the feature name to stop the shared infrastructure.

Two modes run without a person: `--if-idle` is the SessionEnd hook behind a workspace's `auto_stop`, and `--idle` is one pass of the idle reaper over every workspace.

## Examples

```bash
werkmeister stop my-feature
werkmeister stop infra
werkmeister stop --idle 30
```

## See also

`werkmeister down` also releases the slot; `werkmeister pause` freezes the containers instead.
