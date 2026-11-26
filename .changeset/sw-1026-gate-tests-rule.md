---
"werkmeister-core": patch
---

SW-1026: rule 3 of the generated `pr-rules.md` now says that `werkmeister pr gate --tests` skips the PR-file checks and the release check, so it reaches its lint and test rows in a build stage, before a PR file exists. Before this, the rule said only that the PR-file checks stop the gate before any test command, and ICM build stages read their `pr gate --tests` step as unreachable.
