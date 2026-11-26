---
"werkmeister-core": patch
---

`with-temp-home` sends KILL to its command's process group 5 s after it passes on a TERM, so a command that ignores or outlasts TERM no longer outlives the wrapper and leaves its temp HOME behind. A SIGKILL sent straight to the wrapper still runs no trap; send TERM first (SW-1193). Existing workspaces get the new wrapper on `werkmeister machine migrate` or `workspace init`.
