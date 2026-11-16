---
"werkmeister-core": patch
"werkmeister": patch
---

SW-809: `with-fixture-workspace --queue <feature>:<waitedMin>[:<service>,...]` (and `withFixtureWorkspace({ queue })`) seeds a waiter's workspace, compose.yml, lease and `waiting.json`, not only its name, so a starved, whole-feature or service queue head runs through the built CLI. `--queue` now repeats; a bare name still seeds only the name.
