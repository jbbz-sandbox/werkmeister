---
"werkmeister-core": patch
"werkmeister": patch
---

SW-193: a merged PR that needs no release now reaches `shipped`. When the gate's release check runs and reports nothing to bump (changesets' `NO packages to be bumped`), `werkmeister pr open` writes `release: none` into the PR file, and `werkmeister pr status` ships that PR on merge instead of waiting for a release tag that will never contain it, so close-out is no longer stuck. A PR that needs a release still waits for its tag, and `skip_release` still only skips the gate's check.
