---
"werkmeister-core": patch
---

SW-406: the werkmeister-core gate tests run faster: the core container gets 3 CPUs, the core suite's test concurrency follows the container's CPU limit (at most 4), and the two slow compose-probe tests wait about 1 s instead of 11 s (`WERKMEISTER_TIMEOUT_SCALE`, test-only).
