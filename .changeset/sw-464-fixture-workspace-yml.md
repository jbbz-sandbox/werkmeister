---
"werkmeister-core": patch
"werkmeister": patch
---

SW-464: `with-fixture-workspace --workspace <file>` (and `withFixtureWorkspace(fn, { workspace })`) merges a YAML mapping into the fixture's workspace.yml, e.g. `group`, `work_type`, `context_strategy`. Under `context_strategy: icm`, the `--gate` preset writes its PR file, exercise.md and review.md where the icm strategy reads them, so a grouped icm fixture passes `pr gate` with no hand edits.
