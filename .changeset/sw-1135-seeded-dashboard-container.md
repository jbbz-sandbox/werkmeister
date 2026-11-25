---
"werkmeister": patch
---

SW-1135: `workspace serve --dashboard` runs the seeded dashboard in a throwaway `node:22` container on an internal Docker network, mounting only the worktree's `apps/cli/dist` (read-only) and the seeded HOME, with only `127.0.0.1:<port>` forwarded to it; the containers and network are removed when it stops. It now needs Docker.
