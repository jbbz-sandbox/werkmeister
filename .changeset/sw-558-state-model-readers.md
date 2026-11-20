---
"werkmeister": minor
"werkmeister-core": minor
"werkmeister-vscode": minor
---

VS Code and the dashboard read the workspace state model (SW-558). The VS Code card shows the phase, the activity and every needs-you item, the PR poll's included; the dashboard's Health rows show the same chip, phase, activity and needs list as the /workspaces pane. The agent word (Working, Needs you, Done, Idle) is now `workspaceState.agent { id, since }`.

**Breaking:** `WorkspaceStatus.claude` keeps only `state`: `claude.agent`, `claude.at` and `claude.question` are gone, and so is the MCP `status` tool's `claude.agent` enum. Read `workspaceState.agent` for the word and `workspaceState.needs` for what it waits on. The pre-SW-487 `.werkmeister/agent-state.json` `sessions{}` is no longer read. Upgrade the VS Code extension with the CLI: an older extension reads `claude.agent` from this daemon's `status` and its Workspaces view fails to load.
