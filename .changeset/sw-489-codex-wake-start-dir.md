---
"werkmeister-core": patch
"werkmeister": patch
---

SW-489: `pr watch`'s wake finds the folder a session started in through the workspace's harness, so a `harness: codex` session started in a code worktree records `session_cwd` at `pr open` and is resumed from there, not from the workspace root.
