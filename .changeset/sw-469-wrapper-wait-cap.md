---
"werkmeister": patch
"werkmeister-core": patch
---

`with-temp-home` waits at most 90 s for host load (was 10 min), so an agent's foreground call no longer times out before its command starts; `pr gate` keeps its 10 min budget (SW-469).
