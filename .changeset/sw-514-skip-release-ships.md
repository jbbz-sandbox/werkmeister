---
"werkmeister-core": patch
"werkmeister": patch
---

`werkmeister pr status` now marks a merged PR that sets `skip_release` as shipped (`release: none`) on the first run when its diff has no `.changeset/*.md` and the repo's `release_check` is changesets'. Before this, a test-only PR waited for a release tag until `release: none` was set by hand. A PR with a changeset still waits for its tag (SW-514). `with-fixture-workspace` gains `--pr-field <key>=<value>` to add front matter to the seeded PR file.
