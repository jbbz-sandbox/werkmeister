---
"werkmeister": patch
---

SW-294: the `docker context inspect` fallback that picks the Docker endpoint now waits 30 s instead of 10 s, so a load-starved CLI no longer sends werkmeister to the default socket (a different daemon on OrbStack or Colima).
