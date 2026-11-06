# Harnesses

Werkmeister drives the agent harness a workspace is opened in. Claude Code is the
first and fullest; any harness that speaks MCP and reads skills works through the
host daemon. The workspace's `harness` (in `.werkmeister/workspace.yml`, set by
`--harness` on `werkmeister workspace new` / `werkmeister workspace init`, or
`WERKMEISTER_HARNESS`) decides which files `workspace init` writes and where.

| | Claude Code (plugin) | Claude Code (devcontainer) | Generic MCP harness (`harness: mcp`) | Codex CLI (`harness: codex`) |
|---|---|---|---|---|
| Instructions file | `CLAUDE.md` | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` |
| Skills | `.claude/skills/w9r-*` | `.claude/skills/w9r-*` | `.agents/skills/w9r-*` | `.agents/skills/w9r-*` |
| Subagents | `.claude/agents/w9r-*` | `.claude/agents/w9r-*` | none | none |
| MCP server | the plugin's `.mcp.json` (`werkmeister internal mcp`, a stdio proxy to the daemon) | `http://host.docker.internal:3002/mcp` with the workspace token, registered by `postCreateCommand` | the daemon at `http://127.0.0.1:3002/mcp`, registered by you (below) | the daemon, registered by `workspace init` in `.codex/config.toml` (below) |
| Hooks | `.claude/settings.json` (session start, standards gate, PR guard, agent state, auto-stop) | same | **unavailable**: `workspace init` and `werkmeister feature up` print `hooks: unavailable on mcp (…)`, the `hooks` MCP tool returns `hooks: "unavailable: …"`, and `AGENTS.md` carries the note | `.codex/hooks.json` (the same hooks; see [Codex](#codex) for what differs) |
| Session tools (`claude-transcript`, `claude-send`, `claude-resume`, `refine-prompt`, `pr-reconcile`), the Workspaces pane | yes | yes | no: the daemon still lists them, they answer for Claude sessions only | yes, from `~/.codex/sessions` ([Sessions](#sessions)); `refine-prompt` and `pr-reconcile` still run Claude Code |

Examples of a generic MCP harness: Codex CLI, Cursor, GitHub Copilot CLI. Codex
has its own harness with hooks, `harness: codex` ([Codex](#codex)).

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
   and prints `hooks: unavailable on mcp (a generic MCP harness has no hooks adapter; use harness: codex for Codex)`.
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

## Codex

`harness: codex` is the generic MCP layout plus Codex's hooks.

1. **Create the workspace for Codex:** `werkmeister workspace new my-feature --harness codex …`,
   or `werkmeister workspace init --harness codex` on an existing one (delete the old
   `CLAUDE.md` and `.claude/` by hand). `workspace init` and `werkmeister feature up` write:
   - `.codex/hooks.json`: session-start notes and the standards gate (jit), the PR guard,
     agent state and, while `auto_stop` is on, the session-end stop. Hand-added entries
     are kept, like `.claude/settings.json`.
   - `.codex/config.toml`: the werkmeister MCP server at the loopback daemon, with
     `default_tools_approval_mode = "approve"` and `tool_timeout_sec = 1800` (why: step 3
     above), and `bearer_token_env_var = "WERKMEISTER_MCP_TOKEN"`. A `.codex/config.toml`
     you wrote yourself (no werkmeister header) is left as it is, with a warning.
2. **Trust the folder and its hooks, once per workspace.** Codex reads a project's
   `.codex/` only when the folder is trusted (its first-open prompt, or
   `[projects."<path>"] trust_level = "trusted"` in `~/.codex/config.toml`), and runs a hook
   only after `/hooks` has approved it. A werkmeister upgrade that changes a hook command
   asks again. Headless `codex exec` can pass `--dangerously-bypass-hook-trust` instead.
   Werkmeister never writes `~/.codex`.
3. **Start Codex with the workspace's token:**
   `WERKMEISTER_MCP_TOKEN=$(cat .werkmeister/token) codex` (or `codex exec …`). The tools
   are pre-approved, and a loopback call with no token acts as the whole machine (step 1
   above); the workspace token scopes the session to this workspace's tools, and the
   `werkmeister` CLI it runs reads the same variable. The daemon issues
   `.werkmeister/token` only for a workspace under the workspaces root.
   Without the variable, Codex 0.166 skips the server silently: no werkmeister tools,
   rather than machine-wide ones.

What differs from Claude Code:

- Codex edits files through `apply_patch`, so the gate matches `apply_patch` and reads
  the paths from the patch.
- Codex has no `Notification` event: its approval prompts arrive as `PermissionRequest`,
  which marks the session needs-you.
- A paused workspace denies each tool call but cannot end the turn: Codex rejects
  `continue: false` on `PreToolUse`.
- Codex's `SessionEnd` also fires after 30 minutes idle, so with `auto_stop` on the
  feature stops then. Its hook gets at most 3 s.

### Sessions

The session tools and the Workspaces pane follow the workspace's `harness:` (SW-384). The
tools keep their `claude-*` names.

- **Where sessions come from.** Codex files sessions by date under `~/.codex/sessions`
  (`$CODEX_HOME/sessions`); werkmeister reads each rollout's first line and keeps the ones
  whose recorded `cwd` is the workspace folder. Transcript rows are your messages, Codex's
  replies and one line per tool call; the AGENTS.md and environment context Codex injects
  are left out.
- **`claude-send`** runs `codex exec -- <message>` in the workspace, or
  `codex exec resume <id> -- <message>` to continue the newest session. Both pass
  `-c sandbox_mode="workspace-write"`, so a `sandbox_mode` in `~/.codex/config.toml` never
  widens a headless turn. Codex takes no tool allow or deny list on the command line, so an
  unattended turn relies on the PreToolUse gate in `.codex/hooks.json`; the refused-calls
  list a waited turn returns is always empty.
- **Working / Needs you / Done** comes from the agent-state hook, else from the session's
  last line, as on Claude Code.
- **`claude-resume`** and the pane's Continue / New Session open
  `WERKMEISTER_MCP_TOKEN=$(cat .werkmeister/token) codex` (`resume <id>`, `resume --last`).
- **Usage** sums each session's last `token_count`. There is no USD estimate unless
  `~/.werkmeister/model-pricing.yaml` has a row for the model.
- **Not on Codex:** calls with no workspace (the Jira fallback, refining a prompt, PR
  reconcile) still ask Claude Code. The resume nudge's open-session check and the
  `pr watch` wake still look for Claude sessions only.

**CLI, not the SDK.** The adapter runs the `codex` CLI. `codex exec --output-schema` with
`-o` already returns a structured answer, the `@openai/codex-sdk` package wraps the same
binary and would be a new dependency, and the shared turn runner spawns a binary anyway.
The user's own `codex` keeps their login and config. Codex sends the schema in strict mode
(every object closed, every property required), so a free-form JSON answer travels as a
string in `result` and is parsed from there.

## Adding a harness adapter

A harness with its own hooks gets its own layout under
`packages/werkmeister-core/src/harness/<id>/` (`HarnessLayout` in
`harness/types.ts`), registered in `harness/layout.ts`, with its hooks writer
mapping werkmeister's hook events to the harness's file and payload. A harness with
sessions also implements `HarnessAdapter` (`harness/types.ts`) and adds it to
`harnessFor`'s registry in `harness/layout.ts`; `harness/codex/adapter.ts` is the example. The Claude
Code adapter in `harness/claude/` is the reference. The Codex adapter in `harness/codex/` shows the
small case: it reuses `harness/claude/hooks_gen.ts`'s merge with its own file and event map.
