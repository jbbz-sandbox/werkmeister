---
"werkmeister-vscode": patch
---

SW-499: the extension's launch URI (`vscode://jbbz.werkmeister-vscode/claude?…`) takes `remote_control=1`, which starts the session with `--remote-control <workspace>`. The name is the workspace the extension matched, never the query's, and a URI with no matching workspace is refused. `/next-wave` uses it: a wave run from a VS Code integrated terminal now opens each session there, as `claude <W>` with Remote Control on, instead of in Terminal.app.
