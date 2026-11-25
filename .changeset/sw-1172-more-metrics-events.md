---
"werkmeister": minor
---

SW-1172: three more metrics events. `containers.healthy` is logged when `feature up` finds every container of the set healthy as compose returns, with `duration_ms` from the start of the up. `ci.result` is logged once per PR head, by the first `pr status` or `pr watch` pass that sees all its checks finished, with `result` ok or error and `duration_ms` from the first check's start to the last one's end. `session.start` and `session.stop` are logged when a workspace's Claude session starts (new, or resumed after it ended) and ends. Each one carries the run's `run_id` and is described in the events schema.
