---
"werkmeister-core": patch
---

The `feature up` compose timeout (20 minutes) can be set on its own with `WERKMEISTER_UP_TIMEOUT_S`, a test-only setting. `up_exit.test.ts` uses it to time `up` out in 2 s and no longer shrinks every docker call with `WERKMEISTER_TIMEOUT_SCALE`, so the file runs in about 5 s instead of about 22 s.
