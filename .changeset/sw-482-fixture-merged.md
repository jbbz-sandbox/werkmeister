---
"werkmeister-core": patch
"werkmeister": patch
---

SW-482: the fixture's fake gh answers `gh pr view`, and `with-fixture-workspace --merged` (or `withFixtureWorkspace(fn, { merged: true })`) makes it report the PR merged, so a fixture run goes `workspace init → pr open → pr status → workspace close` with exit 0.
