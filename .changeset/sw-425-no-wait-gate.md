---
"werkmeister": patch
---

`WERKMEISTER_NO_WAIT=1` now skips the `pr gate` / `pr open` host-load wait too, not only `with-temp-home`'s; `with-temp-home --no-wait` exports it, so `with-fixture-workspace --no-wait … --then pr gate` runs without a load wait (SW-425). Regenerate a workspace's wrapper with `werkmeister workspace init`.
