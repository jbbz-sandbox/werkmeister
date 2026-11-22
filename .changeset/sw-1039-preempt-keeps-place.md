---
"werkmeister": patch
"werkmeister-core": patch
---

A preempted workspace now goes to the head of the capacity queue, not the back (SW-1039): it was admitted before every start waiting now, so the next room that frees starts it first. It still preempts an idle feature only after waiting 5 minutes, as any plain queue head does.
