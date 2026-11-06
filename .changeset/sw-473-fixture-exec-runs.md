---
"werkmeister-core": patch
"werkmeister": patch
---

SW-473: `with-fixture-workspace --exec-runs` (and `withFixtureWorkspace(fn, { execRuns: true })`) makes the fixture's fake docker run each `docker exec` command with `sh -c` in the fixture's code repo and return its exit code, so a fixture `pr gate` passes or fails on the registry's `lint` and a service's `test:`. Without it the fake still logs each exec and answers 0. `--exec-runs` must come first, and a workspace's Claude settings get `ask` rules for it (beside the wrapper's allow rule), because it runs the registry's rows on the host; `machine migrate` adds them to existing workspaces. The fixture also blanks `GITHUB_TOKEN`.
