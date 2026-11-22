---
"werkmeister": patch
---

While a workspace waits for capacity, the hook holds a command only when it runs `docker`, `pnpm`, `node` and the other held programs, not when a commit message, `printf`, `sed` or heredoc only mentions them (SW-1065).
