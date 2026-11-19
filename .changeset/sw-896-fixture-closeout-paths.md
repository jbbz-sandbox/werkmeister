---
"werkmeister-core": patch
---

`with-fixture-workspace` gains `--postmortem` (seeds `postmortem.md`, so `workspace abandon` and `close` run without `--skip-postmortem`), `--worktrees` (each repo a worktree of its source clone on `<user>/demo`, as init makes them, so `pr push` takes it) and `--jira` (a fake Jira for Jira keys, its calls printed as `--- jira calls`). `withFixtureWorkspace` takes `postmortem`, `worktrees` and `jira: true` (calls in `fx.jiraCalls`) (SW-896).
