---
"werkmeister": minor
---

New generated `.werkmeister/bin/with-fixture-workspace`: one command seeds a temp fixture workspace (registry, a code repo with a local bare origin, logging fakes for gh and docker, dead Docker, daemon and Jira addresses), runs this workspace's built CLI against it (`--then` chains steps, `--print` shows files, `--gate` adds a ready PR) and removes it. Core tests get the same fixture from `withFixtureWorkspace` (SW-292).
