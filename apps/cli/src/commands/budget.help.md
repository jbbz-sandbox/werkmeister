## Description

Shows the scheduler's budget and who is using it: the memory and CPUs a feature's containers may take in total (`budget:` in `~/.werkmeister/config.yaml`, else the Docker engine's memory less 1 GiB and every CPU), the host-load ceiling `with-temp-home`, and a start that runs a setup service, wait under (not on macOS), whether a start that doesn't fit may stop features whose session is idle or waiting on a person (and a person's `feature up` a working autonomous one), the features holding a slot, each **Running** feature with the CPUs and memory it holds, its session state (idle, waiting on a person, working, a person's workspace) and whether a gate is running, and the features **Waiting** for room in admission order (gate starts first), each with what it waits to start, what that costs, and how long it has waited.

It reads only: with the host daemon up it asks the daemon for the queue, otherwise it reads `~/.werkmeister/scheduler/` itself.

## Examples

```sh
werkmeister budget status
werkmeister budget status --json
```
