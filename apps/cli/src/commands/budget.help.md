## Description

Shows the scheduler's budget and who is using it: the memory and CPUs a feature's containers may take in total (`budget:` in `~/.werkmeister/config.yaml`, else the Docker engine's memory less 1 GiB and every CPU), the host-load ceiling the PR gate waits under, whether a person's `feature up` may preempt an autonomous run, the features holding a slot, and the features **Waiting** for room in the order they will start.

It reads only: with the host daemon up it asks the daemon for the queue, otherwise it reads `~/.werkmeister/scheduler/` itself.

## Examples

```sh
werkmeister budget status
werkmeister budget status --json
```
