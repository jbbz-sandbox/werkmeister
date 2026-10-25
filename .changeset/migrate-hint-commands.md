---
"werkmeister-core": patch
"werkmeister": patch
---

SW-97: `werkmeister migrate` no longer tells the person to run `werkmeister infra down` and `werkmeister infra up`, which don't exist. The refusal while shared infra is running now names `werkmeister down infra`, and the success message names `werkmeister connect`. A new test fails the build if any backticked `werkmeister …` command in migrate's messages isn't a registered CLI command.
