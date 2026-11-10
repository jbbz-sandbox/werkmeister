---
"werkmeister": patch
"werkmeister-core": patch
---

The ICM exercise step stops before any browser check when `werkmeister feature up` warns that a routed hostname does not resolve, and asks the person to run `werkmeister machine setup`. It never bypasses a certificate warning; a published-port fallback is recorded in `exercise.md` as a deviation only when the person says to skip setup.
