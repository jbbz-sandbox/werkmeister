---
"werkmeister-core": patch
"werkmeister": patch
---

SW-224: the generated `with-temp-home` waits before its command while the host's 1-minute load is above `budget.host_load`, using the pr gate's wait (same default, same 30-minute cap, then it runs anyway and says so), through the new internal `werkmeister wait-load`. `WERKMEISTER_NO_WAIT=1` skips it; with no `werkmeister` on PATH the wrapper runs at once.
