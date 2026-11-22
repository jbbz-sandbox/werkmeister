---
"werkmeister": patch
"werkmeister-core": patch
---

A passing `pr gate` or `pr gate --tests` now leaves the containers it started running (row: `started … for the gate, left running for \`pr open\``), so the `pr open` after it finds them up instead of queueing for capacity again (SW-1046). The idle reaper and preemption still reclaim them. A failing gate, and `pr open`'s own gate, stop them as before; with several PR files this holds per file.
