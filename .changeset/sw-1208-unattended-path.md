---
"werkmeister": patch
"werkmeister-core": patch
---

SW-1208: the ICM stages that settle a design (01 reproduce, 01 research) now ask, in their pre-approved-input step, whether a widened path runs with no person present (headless, unattended, a relay or callback). If it does, it gets the unattended deny floor unless the design says why not. So the decision is made at 01, not found at review.
