---
"werkmeister-core": patch
---

`sandbox pr watch` now resumes terminal sessions that ran `sandbox pr open` from a code worktree or other subfolder. `pr open` records the session's start folder (`session_cwd`, from its transcript), and delivery looks the session up and runs `claude -p --resume` from there. It still never falls back to another session.
