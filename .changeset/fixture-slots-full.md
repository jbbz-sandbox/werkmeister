---
"werkmeister": patch
---

`with-fixture-workspace --slots-full` (and `withFixtureWorkspace(fn, { slotsFull: true })`) leases every fixture slot to other features before the werkmeister args run, so a no-slot path such as `workspace init --no-build` runs through the built CLI (SW-634).
