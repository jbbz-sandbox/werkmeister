---
"werkmeister-plugin": patch
---

`rank.py` reads its retry base delay from `RANK_RETRY_DELAY` (seconds, default 1, unchanged); `test_rank.py` sets it to 0 so the triage tests skip the real sleeps (SW-1239).
