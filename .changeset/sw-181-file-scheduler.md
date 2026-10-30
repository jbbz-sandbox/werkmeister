---
"werkmeister-core": minor
"werkmeister": minor
---

SW-181: a file-backed scheduler. A slot is leased in `~/.werkmeister/scheduler/leases.json` the moment it is allocated, so back-to-back creates get distinct slots, and `up`, the gate and `pr open` never move a leased slot: they fail naming whoever sits on it. `up` admits a feature only when the budget (Docker's memory minus 1G and its CPUs by default, `budget:` in config.yaml to override) has room for its memory reservations and CPU limits; otherwise it waits in a queue, its session is held like a pause, and it starts when another feature stops or on the `pr watch` tick. A person's `up` may stop an autonomous feature to make room (`budget.preempt: false` turns it off). The gate checks its ports are free before starting anything, `status` shows the queue, and generated compose sets `memswap_limit` equal to each memory limit.
