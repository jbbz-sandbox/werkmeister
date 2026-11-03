---
"werkmeister": patch
---

SW-361: the CLI bundle (`werkmeister#build`) is no longer turbo-cached. Its build stamp (HEAD plus the dirty flag) is not a turbo input, so a build cached from an uncommitted tree replayed after the commit with a stale stamp, and the PR gate's `bins.test.ts` failed on the stale-build notice. The bundle rebuilds in under a second on every run.
