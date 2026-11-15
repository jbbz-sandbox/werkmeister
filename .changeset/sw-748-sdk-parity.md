---
"werkmeister-core": minor
---

**Breaking (SDK):** `up` on `werkmeister-core/sdk` is now `infraUp`. It always started the shared infrastructure, not a workspace. Replace `up()` with `infraUp()`. A workspace's own stack is `runWorkspaceAction(name, "up")`. The Workspaces pane's Connect button works with either core version once the plugin is updated; an older plugin on this CLI fails Connect with `core.up is not a function` until it updates.

The SDK now covers everything the MCP server and CLI offer (SW-748): `infraDown`, `infraStop`, `infraRestart`, `infraHealth` and `connectK8s`; `WorkspaceAction` and `WORKSPACE_ACTIONS`; and the functions behind every MCP tool and CLI command, with their argument and result types. `docs/sdk-parity.md` maps each one. The SDK reference adds a Lifecycle section and every `callTool` tool name with its arguments.
