---
"werkmeister": patch
---

SW-410: `pr open` retries a push that GitHub refuses with an SSH auth or connection error (twice, 10 s then 30 s apart), and a push that still fails points at githubstatus.com. When `issue start` can't fetch, its `Worktree:` line says to re-check with `werkmeister issue start`, and the first stage contract (and the w9r-research skill) now re-runs it before going on instead of continuing unchecked. Rule 3 in the generated `_shared/pr-rules.md` runs `pr open` as a harness-tracked background job instead of `nohup … &`.
