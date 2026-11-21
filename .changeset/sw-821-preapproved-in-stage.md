---
"werkmeister-core": patch
"werkmeister": patch
---

The ICM fix and implement contracts now apply the pre-approved-input rule to any allow rule or pre-approved command the stage itself adds: list what each accepted value can reach, allowlist by default, and put that list in the stage output and in the question that asks for approval (SW-821).
