---
"werkmeister-core": patch
"werkmeister": patch
---

SW-278: `werkmeister pr gate` no longer passes silently with zero tests run when a PR's changed files map to no service (for example, the registry has no `repos:` entry for the worktree). It fails a `tests` row that names the files, unless the PR file sets `skip_tests: { tests: <reason> }`. An empty diff and a docs-only diff (all `no_service_paths`) behave as before. The `cli` validate text now says what a gate fixture needs.
