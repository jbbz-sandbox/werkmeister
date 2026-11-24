---
"werkmeister-core": patch
"werkmeister-mcp": patch
---

SW-1110: a gate's start of a queued feature no longer races the waiting queue's start of the same feature. Two `docker compose up`s of one feature now run one after the other, so neither SIGTERMs the other's containers. A grant skips a feature that a direct start (a gate's, a person's `feature up`) took out of the queue after the grant read it, so it starts once and its session gets no false "Could not start" message.
