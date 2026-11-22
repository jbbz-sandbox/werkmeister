---
"werkmeister-core": patch
---

When a gate row fails because its container stopped while the row ran, the gate now says so, names who stopped it from werkmeister's stop record (when and why, such as a preemption or the idle reaper) or says that werkmeister recorded no stop, and exits 75 with "rerun `werkmeister pr open`", rather than reporting the change as failing (SW-998). A gate that is running already counted as busy, so preemption and the reaper keep it; a test now pins that for preemption too.
