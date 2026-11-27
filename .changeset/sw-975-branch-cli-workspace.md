---
"werkmeister": patch
---

SW-975: `internal branch-cli` says `checking and running <dist>` before handing over to the branch build, which may still refuse a stale build, and it refuses with exit 2 when no `.werkmeister/workspace.yml` is above the cwd instead of treating the nearest git checkout's parent as a workspace.
