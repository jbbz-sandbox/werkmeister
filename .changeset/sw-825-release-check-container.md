---
"werkmeister-core": patch
---

SW-825: the generated propose-stage contract says to start the release check's container with `werkmeister feature up --service <name>` first, since an earlier `pr gate --tests` stopped the containers it started.
