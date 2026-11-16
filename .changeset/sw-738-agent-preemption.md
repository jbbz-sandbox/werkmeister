---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity queue (SW-738): an agent's `feature up` in a person's workspace no longer starts as the person, so it can't stop another workspace's working containers. A start whose preemption fails to stop a container now puts that feature back in the queue to come back, and waits at the head of the queue itself, instead of leaving the other feature down and its own start not started.
