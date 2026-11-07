---
"werkmeister": patch
---

SW-542: `pr gate` and `pr open` no longer wait on host load before lint, each test and the release check. The 1-minute load counted the gate's own install and test rows (an idle 12-core Mac read 36–60 after its own rows, and in the hundreds during a macOS stall with every container idle), so a gate on an idle host waited 1.5–5 min on load it caused. The services a gate starts are already admitted against the budget (SW-540). `--no-wait` is still accepted and does nothing; `with-temp-home`'s own 90 s wait and the host-load line on a failed row are unchanged.
