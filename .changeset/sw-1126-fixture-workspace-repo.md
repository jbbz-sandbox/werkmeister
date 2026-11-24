---
"werkmeister": patch
"werkmeister-core": patch
---

`with-fixture-workspace --workspace-repo` seeds `<repos_root>/sandbox-workspace` as a clone of the fixture's record origin, as `machine setup` would, so `--then metrics rebuild` reads the record branch instead of failing "no workspace repo". `--pr-field url=https://github.com/o/<repo>/pull/<n>` sets the PR file's link. A `--then` step after a close-out that deleted the workspace folder runs from the fixture root; it used to exit 1 with no message (SW-1126).
