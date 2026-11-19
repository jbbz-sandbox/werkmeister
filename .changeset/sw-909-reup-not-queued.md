---
"werkmeister": patch
---

A `werkmeister feature up` of a feature that already runs no longer queues it when the rest of its set doesn't fit: its containers keep running, it exits 75 with "rerun", and its session is not held. Before, the wait wrote `waiting.json` over live containers, and the capacity hook denied every docker, pnpm and node call until a grant re-upped it. The hook's "Waiting for capacity" message now says to confirm with `docker ps` and wait for the grant notice rather than stop (SW-909).
