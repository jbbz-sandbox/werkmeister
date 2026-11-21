---
"werkmeister": patch
"werkmeister-core": patch
---

`internal branch-cli <args>` runs a werkmeister workspace's branch-built CLI (`apps/cli/dist/main.js`) from the host against its real containers, with the installed CLI's root and `node_modules`; it runs only `pr gate` and `feature up`/`stop`/`status`, refuses a missing or stale dist, leaves the shared Caddyfile alone, and its `werkmeister`/`w9r` form always asks (SW-555). The werkmeister repo's install container now mounts the worktree's `werkmeister-install-startup.sh`, so a branch's change to it runs in its own containers.
