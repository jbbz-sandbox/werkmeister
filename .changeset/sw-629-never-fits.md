---
"werkmeister": patch
"werkmeister-core": patch
---

SW-629: a start whose CPUs or memory alone are more than the whole scheduler budget fails at once with `NEVER_FITS`, naming the cost and the budget of the first resource over (`cost 5.0 CPUs > budget 4`) and the fix (raise the engine's CPUs or memory, or `budget.cpus` / `budget.memory` in `~/.werkmeister/config.yaml`, or start fewer services). Before, `feature up` queued it for good and the gate's service starts waited 10 minutes and failed `NO_CAPACITY`, though no preemption could ever make room.
