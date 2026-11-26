---
"werkmeister": patch
"werkmeister-core": patch
---

SW-1213: while a `werkmeister pr gate` runs, it keeps `.werkmeister/gate-running` in the workspace: written at start, touched every minute, removed when the gate ends. The werkmeister plugin's Stop guard stays quiet about proposed items while that file is under 3 minutes old. So a stage turn that ends to wait on its gate is no longer told to ask its proposed review.md. The first stop after the gate ends is. A marker left by a killed gate stops counting after 3 minutes. The file is in the workspace's managed `.gitignore`.
