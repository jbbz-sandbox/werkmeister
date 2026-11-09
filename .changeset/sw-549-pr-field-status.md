---
"werkmeister": patch
"werkmeister-core": patch
---

`with-fixture-workspace --gate --pr-field status=<value>` sets the seeded PR file's `status:` line verbatim (one line, a `# note` included), so a fixture run can check how `pr gate` reads a status form, e.g. `"status=approved  # approved via check-in 2026-11-06"`.
