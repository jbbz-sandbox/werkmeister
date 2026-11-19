---
"werkmeister-core": patch
---

`with-fixture-workspace` and `withFixtureWorkspace` blank `CLAUDE_BIN`, `CODEX_BIN`, `OPENCODE_BIN`, `WERKMEISTER_WORKSPACE_CONFIG` and `WERKMEISTER_CACHE_FILE` instead of passing the caller's through. A fixture step's `claude`, `codex` and `opencode` are now always the failing stubs (OpenCode is newly stubbed), so the Jira fallback to `claude -p` can never reach the real tracker, and the caller's workspace config and issue cache are never read or written. A core test that needs a fake sets one with `withFixtureWorkspace`'s `claudeBin` / `codexBin`; the CLI wrapper has no flag for them (SW-911).
