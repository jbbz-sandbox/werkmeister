---
"werkmeister-core": patch
"werkmeister": patch
---

SW-488: Resume's open-session guard matches the workspace's harness, so in a `harness: codex` workspace an open interactive `codex` gets a pending "continue" instead of a headless `codex exec resume` beside it.
