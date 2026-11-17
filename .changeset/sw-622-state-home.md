---
"werkmeister-core": patch
"werkmeister-vscode": patch
---

`WERKMEISTER_CONFIG_FILE` now moves all of werkmeister's state with the config: locks, reconcile state, the issue cache, the daemon's `mcp-token`, its pid and log files, workspace tokens, VS Code terminal pid files and the legacy `slots.json`. Before, these stayed in the real `~/.werkmeister`. A process with a relocated config therefore no longer touches the real home. With the variable unset, every path is the same as before (SW-622).
