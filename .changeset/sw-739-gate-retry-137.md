---
"werkmeister": patch
"werkmeister-core": patch
---

`pr gate` / `pr open` (SW-739): a test row killed with exit 137 under host load is run once more, after the host-load wait `with-temp-home` uses, and its row says it was retried. It fails only if the retry fails too.
