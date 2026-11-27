---
"werkmeister-core": patch
---

`werkmeister-core/worktrees` exports `RUNTIME_FILES`, the runtime files a workspace's `.gitignore` carries, so tests build their expected ignore lines from it (SW-1237).
