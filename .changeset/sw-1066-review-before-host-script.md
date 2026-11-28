---
"werkmeister": patch
---

SW-1066: the ICM bugfix and incident `03_exercise` contract now runs the code review before it asks the person for any manual result, and every stage that hands the person a host script first has a fresh review subagent check that script, so a script the person runs on the host is reviewed code first.
