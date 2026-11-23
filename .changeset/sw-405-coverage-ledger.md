---
"werkmeister": minor
"werkmeister-core": minor
---

SW-405: coverage goes into the metrics ledger. A new `coverage` event records one package's lines, branches, functions and statements % with its test count and duration. The PR gate logs one per package report its test rows write (`source: "gate"`), and `werkmeister metrics rebuild` imports CI's `coverage-summary` artifacts (`ci-pr`, `ci-main`). Close-out writes `coverage.json` to the record branch with the coverage of each PR's changed files. werkmeister's own gate rows now run `test:coverage`.
