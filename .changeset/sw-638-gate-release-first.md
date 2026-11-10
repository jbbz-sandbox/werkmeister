---
"werkmeister": patch
"werkmeister-core": patch
---

`werkmeister pr gate` and `pr open` run the release check (`release_check`, e.g. `changeset status`) before lint and the test commands. A missing changeset fails the release row in seconds and the tests are not run. A running container gets its setup one-shot re-run first. With nothing running, the check uses the first container the tests would start, so a passing gate starts no extra container, unless that service starts from the branch's own settings (`compose.gate.yml`).
