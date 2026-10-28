---
"werkmeister": patch
---

`pnpm turbo run build --filter=werkmeister` rebuilds `dist/mcp.js` after a commit that changes only `apps/werkmeister-mcp` (SW-131). `apps/cli` now declares `werkmeister-mcp` as a workspace dependency, so turbo's hash for `werkmeister#build` covers the sources esbuild bundles into `mcp.js` and the rebuild command in the stale-build warning clears the warning instead of replaying a stale cache. A test keeps `BUNDLE_SOURCES` and the declared dependencies in step.
