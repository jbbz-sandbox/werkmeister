---
"werkmeister": patch
"werkmeister-core": patch
---

Tests only: `up_exit.test.ts` drops an inherited `WERKMEISTER_ROOT`, and the `waitForSetupLoad` tests restore `WERKMEISTER_NO_WAIT` (SW-671).
