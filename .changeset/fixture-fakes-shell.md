---
"werkmeister": patch
"werkmeister-core": patch
---

The fixture's fake `gh` and `docker` (`with-fixture-workspace`, `withFixtureWorkspace`, `withFakeGh`) are POSIX shell scripts that read their world from plain files, not Node scripts reading `world.json`. A call took ~100 ms to start Node; a fixture flow makes dozens, so the fixture-workspace tests run up to 2x faster. Their output, exit codes and call logs are unchanged.
