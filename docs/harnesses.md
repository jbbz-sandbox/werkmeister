# Harnesses

Werkmeister drives the agent harness a workspace is opened in. Claude Code is the
first and fullest; any harness that speaks MCP and reads skills works through the
host daemon. The workspace's `harness` (in `.werkmeister/workspace.yml`, set by
`--harness` on `werkmeister workspace new` / `werkmeister workspace init`, or
`WERKMEISTER_HARNESS`) decides which files `workspace init` writes and where.

| | Claude Code (plugin) | Claude Code (devcontainer) | Generic MCP harness (`harness: mcp`) |
|---|---|---|---|
| Instructions file | `CLAUDE.md` | `CLAUDE.md` | `AGENTS.md` |
| Skills | `.claude/skills/w9r-*` | `.claude/skills/w9r-*` | `.agents/skills/w9r-*` |
| Subagents | `.claude/agents/w9r-*` | `.claude/agents/w9r-*` | none |
| MCP server | the plugin's `.mcp.json` (`werkmeister internal mcp`, a stdio proxy to the daemon) | `http://host.docker.internal:3002/mcp` with the workspace token, registered by `postCreateCommand` | the daemon at `http://127.0.0.1:3002/mcp`, registered by you (below) |
| Hooks | `.claude/settings.json` (session start, standards gate, PR guard, agent state, auto-stop) | same | **unavailable**: `workspace init` and `werkmeister feature up` print `hooks: unavailable on mcp (…)`, the `hooks` MCP tool returns `hooks: "unavailable: …"`, and `AGENTS.md` carries the note |
| Session tools (`claude-transcript`, `claude-send`, `claude-resume`, `refine-prompt`, `pr-reconcile`), the Workspaces pane | yes | yes | no: the daemon still lists them, they answer for Claude sessions only |

Examples of a generic MCP harness: Codex CLI, Cursor, GitHub Copilot CLI. Codex
is the one this was verified on (the Codex hooks adapter is SW-189).

## Connecting a generic MCP harness

1. **The daemon must be running.** `werkmeister daemon status` says whether it is;
   `werkmeister machine setup` installs it as a launchd agent (`werkmeister daemon install`
   is the same step). On a loopback bind the daemon takes a request with no
   `Authorization` header as the host itself, so a harness on the same machine
   needs no token.
2. **Create the workspace for that harness:**

   ```bash
   werkmeister workspace new my-feature --harness mcp --repos app --services backend
   ```

   `workspace init` writes `AGENTS.md`, projects the skills into `.agents/skills/`,
   and prints `hooks: unavailable on mcp (a generic MCP harness has no hooks adapter; SW-189 adds Codex)`.
   Re-running `werkmeister workspace init --harness mcp` on an existing workspace
   switches it; delete the old `CLAUDE.md` and `.claude/` by hand.
3. **Register the server in the harness.** The URL is `http://127.0.0.1:3002/mcp`
   (`overrides.mcp_port` in `~/.werkmeister/config.yaml` or `WERKMEISTER_MCP_PORT`
   changes the port).

   - Codex CLI: `codex mcp add werkmeister --url http://127.0.0.1:3002/mcp`, or in
     `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

     ```toml
     [mcp_servers.werkmeister]
     url = "http://127.0.0.1:3002/mcp"
     # Headless `codex exec` refuses tools that write unless the server is pre-approved,
     # and its 300 s default cuts off a first `up` while the worktree installs.
     default_tools_approval_mode = "approve"
     tool_timeout_sec = 1800
     ```

   - Cursor: `.cursor/mcp.json` in the workspace:

     ```json
     { "mcpServers": { "werkmeister": { "url": "http://127.0.0.1:3002/mcp" } } }
     ```

   - GitHub Copilot CLI: `/mcp add`, type HTTP, the same URL.

   A harness running **inside a container** sends the workspace's token instead:
   `Authorization: Bearer $(cat .werkmeister/token)` (Codex: `bearer_token_env_var`),
   which scopes it to that one workspace. The devcontainer `workspace init` generates
   does this for Claude Code.
4. **Skills.** Codex reads `.agents/skills` from the repository root. A harness that
   reads another directory can point at it or copy it; `werkmeister skills check`
   and `werkmeister skills sync` keep the projected copy fresh wherever the layout puts it.
5. **Work as usual.** `AGENTS.md` routes the session exactly as `CLAUDE.md` would;
   the daemon's tools create workspaces, bring features up and open PRs
   (`create-workspace`, `up`, `workspace-pr`). What the hooks did for Claude Code
   is yours to do by hand on this harness: nothing injects the notes at session
   start, nothing gates a first edit behind the standards, nothing blocks a PR
   opened any way but `werkmeister pr open`, and the Workspaces pane shows the
   session as idle because no agent-state hook reports it.

## Adding a harness adapter

A harness with its own hooks gets its own layout under
`packages/werkmeister-core/src/harness/<id>/` (`HarnessLayout` in
`harness/types.ts`), registered in `harness/layout.ts`, with its hooks writer
mapping werkmeister's hook events to the harness's file and payload. The Claude
Code adapter in `harness/claude/` is the reference.
