---
"werkmeister-core": minor
"werkmeister": minor
---

SW-675, SW-668: a wave of workspaces on a small budget no longer deadlocks on the capacity queue, and capacity waits no longer stop for a person.

- Backfill: a start that fits goes ahead of a queue head that doesn't. It stops passing once the head is a gate's start or has waited 5 minutes. Gate starts queue ahead of plain `feature up`s.
- In an autonomous workspace, a `--service` or gate start that has to wait while its feature already runs containers stops them first. Nothing is held while it waits, and it starts them again with the new service. Two gates each holding werkmeister-core no longer wait on each other.
- A plain `feature up` at the head of the queue may stop idle or waiting-on-a-person features after 5 minutes (`budget.preempt: false` still turns all preemption off).
- The idle reaper stops a feature whose session has waited on a person's answer for `overrides.idle_stop_minutes`, but only while another feature waits for capacity.
- Exit 75 means "no capacity yet, rerun": a queued `feature up` (it was 0), a `--service` start that waited 10 minutes (it was 1), and `pr gate` / `pr open` when every failure was a capacity wait (gate reads `retry later (no capacity)`). Scripts that treat any non-zero exit as failure now see a queued `feature up` as one. Each message lists who holds the budget, the head it waits behind, and whether a person is needed.
- `budget status` lists each running feature's CPUs, memory, session state and running gate, and each waiter's need and wait, in admission order. `--json` adds `running` and `waiters`.
