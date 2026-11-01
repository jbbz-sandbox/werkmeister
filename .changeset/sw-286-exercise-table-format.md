---
"werkmeister-core": patch
"werkmeister": patch
---

SW-286: `pr gate` / `pr open` check `exercise.md` with the PR-file checks, so a malformed exercise table (`PASS: …`, `(reproduces bug)`) fails before any test command runs instead of after them. The generated ICM contracts that write `exercise.md` (03_implement, the bug-fix/incident 03_exercise, the refactor implement stage) now say the result cell is exactly `PASS` or `FAIL` with output in its own column (`| check | result | evidence |`, or `detail` for 03_exercise), that this holds for every table in the file, and that a superseded run goes in prose, not a `FAIL` row. 04_propose says the same for every result-column table in the PR body, and the JIT `w9r-test` skill matches.
