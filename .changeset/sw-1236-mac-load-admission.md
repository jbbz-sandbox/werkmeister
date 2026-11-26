---
"werkmeister-core": minor
"werkmeister": minor
---

SW-1236: on macOS every start the scheduler admits (`feature up`, `feature up --service`, the gate's container starts, the queue's grants) waits while the Mac's own 1-minute load is over `budget.host_load_mac` (default 4 × CPUs, `0` off), says `host load N is over L (budget.host_load_mac)`, and preempts nobody; the daemon starts a waiter held by load once the load falls. `budget status` shows each load's reading beside its limit: the JSON's `host_load` is now `{ vm: { load, limit }, mac: { load, limit } | null }` instead of the VM limit alone, and the text reads `Docker VM load 3.1 (limit 24), Mac load 23.5 (limit 48)`.
