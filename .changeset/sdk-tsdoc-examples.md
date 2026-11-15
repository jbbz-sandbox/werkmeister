---
"werkmeister-core": patch
---

SDK reference rewritten for people building on `werkmeister-core/sdk`. The 45 longest-standing exports now say what they do, what they return and throw, and whether they need the daemon, each with an example that imports from `werkmeister-core/sdk`. A test type-checks every example against the built SDK. The exports added for SDK parity get the same treatment in a follow-up. No API change.
