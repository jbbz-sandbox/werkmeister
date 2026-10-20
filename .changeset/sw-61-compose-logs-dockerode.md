---
"werkmeister": patch
"werkmeister-core": patch
"werkmeister-vscode": patch
---

`werkmeister logs`, the MCP `logs` tool and the VS Code logs pane read container logs from the Docker Engine API instead of running `docker compose logs` (SW-61). The output is the same: compose's `name | ` prefix, coloured per service, coloured only onto a terminal for the CLI and always in the pane. An unknown service prints `no such service: <name>`. A followed tail now picks up containers that start or restart after it began. The VS Code pane no longer needs `docker` on PATH, so it works from a VS Code launched from the Dock. `composeLogsStream` returns a `{ stop(), done }` handle instead of a `ChildProcess`, and loses its `env` parameter; `composeLogsArgs` is gone.
