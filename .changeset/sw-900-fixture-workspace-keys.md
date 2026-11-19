---
"werkmeister-core": patch
---

`with-fixture-workspace --workspace <file>` (and `withFixtureWorkspace`'s `workspace` option) now takes only `auto_stop`, `autonomous`, `context_strategy`, `description`, `group`, `issue_id`, `labels`, `model`, `repos`, `starting_prompt`, `task` and `work_type`. Any other key is refused with exit 2, as `--config` already does, since the wrapper is pre-approved and its arguments are its only limit (SW-900).
