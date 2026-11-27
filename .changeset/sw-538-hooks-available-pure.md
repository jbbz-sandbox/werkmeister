---
"werkmeister-core": patch
---

SW-538: pausing an OpenCode workspace no longer rewrites `opencode.json` and its plugin or prints `Wrote …`. `hooksAvailable()` is now a pure check, and the hook writers (workspace init, `feature up`, the `hooks` tool) write OpenCode's files through `writeHarnessHooks()`.
