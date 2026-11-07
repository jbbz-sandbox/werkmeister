---
"werkmeister-core": minor
"werkmeister": minor
---

SW-509: the fixture has a GitHub project for `o/<repo>#N` refs, so a seeded issue resolves to the fake gh. `with-fixture-workspace --issue o/app#1` (or `withFixtureWorkspace(fn, { issue })`, or `issue_id` / `group:` in a `--workspace` file) shows `issue start`, `pr open`, `pr status` and `workspace close` moves (`gh issue edit` / `close` / `comment`, for the lead and each member) in `--- gh calls`. Jira keys still resolve to Jira.
