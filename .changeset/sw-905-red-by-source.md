---
"werkmeister-core": patch
"werkmeister": patch
---

The bugfix fix contract now says how to show a test red: revert the fix in source without losing it (save an uncommitted fix as a patch first; never the shared stash), force-rebuild, run the test, then restore and force-rebuild again; never edit `dist/` or another build output by hand (SW-905).
