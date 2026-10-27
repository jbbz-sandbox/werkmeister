---
"werkmeister": patch
---

SW-128: the stale-build warning no longer fires when HEAD moved only outside the CLI bundle's sources (`apps/cli`, `apps/werkmeister-mcp`, `packages/werkmeister-core`, `pnpm-lock.yaml`). turbo replays a cached `dist` for such a commit, still stamped with the older SHA, so the warning appeared after every docs-only pull and the rebuild it named could not clear it. The PR gate's cli tests now pass in the docs-site container: `bins.test.ts` no longer sees that warning, `lifecycle_own_container.test.ts` sets `WERKMEISTER_FEATURE`, and the docs-site container gets 2G (512M and 1G OOM-killed a cold cli typecheck and test run there).
