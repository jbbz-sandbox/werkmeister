# Harnesses

Werkmeister drives the agent harness a workspace is opened in. Claude Code is the
first and fullest; any harness that speaks MCP and reads skills works through the
host daemon. The workspace's `harness` (in `.werkmeister/workspace.yml`, set by
`--harness` on `werkmeister workspace new` / `werkmeister workspace init`, or
`WERKMEISTER_HARNESS`) decides which files `workspace init` writes and where.

| | Claude Code (plugin) | Claude Code (devcontainer) | Generic MCP harness (`harness: mcp`) | Codex CLI (`harness: codex`) | OpenCode (`harness: opencode`) |
|---|---|---|---|---|---|
| Instructions file | `CLAUDE.md` | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | `AGENTS.md` |
| Skills | `.claude/skills/w9r-*` | `.claude/skills/w9r-*` | `.agents/skills/w9r-*` | `.agents/skills/w9r-*` | `.agents/skills/w9r-*` |
| Subagents | `.claude/agents/w9r-*` | `.claude/agents/w9r-*` | none | none | none |
| Question tool (stage human checks, SW-517) | `AskUserQuestion` | `AskUserQuestion` | none: a numbered plain-text block | none: a numbered plain-text block | `question` |
| MCP server | plugin `.mcp.json` | daemon over `host.docker.internal` | daemon, registered by you | daemon, via `.codex/config.toml` | `opencode.json` |
| Hooks | `.claude/settings.json` | same | **unavailable** | `.codex/hooks.json` | `.opencode/plugins/werkmeister.js` (partial) |
| Session tools and Workspaces pane | yes | yes | no | yes | yes (limited) |

Details for the three rows above:

- **MCP server.** Claude Code (plugin): the plugin's `.mcp.json` (`werkmeister internal mcp`, a stdio proxy to the daemon). Claude Code (devcontainer): `http://host.docker.internal:3002/mcp` with the workspace token, registered by `postCreateCommand`. Generic MCP harness: the daemon at `http://127.0.0.1:3002/mcp`, registered by you (below). Codex CLI: the daemon, registered by `workspace init` in `.codex/config.toml` (below). OpenCode: `mcp.werkmeister` in the workspace's `opencode.json`, written by `workspace init`.
- **Hooks.** Claude Code: session start, standards gate, PR guard, agent state, auto-stop. Generic MCP harness: `workspace init` and `werkmeister feature up` print `hooks: unavailable on mcp (…)`, the `hooks` MCP tool returns `hooks: "unavailable: …"`, and `AGENTS.md` carries the note. Codex CLI: the same hooks; see [Codex](#codex) for what differs. OpenCode: standards gate, PR guard and agent state; session-start context and auto-stop do not run (no such OpenCode events), and `workspace init` prints `hooks: partial on opencode (…)`.
- **Session tools** (`claude-transcript`, `claude-send`, `claude-resume`, `refine-prompt`, `pr-reconcile`) **and the Workspaces pane.** Generic MCP harness: the daemon still lists them, they answer for Claude sessions only. Codex CLI: yes, from `~/.codex/sessions` ([Sessions](#sessions)); `refine-prompt` and `pr-reconcile` still run Claude Code. OpenCode: yes, over `opencode run`; the dashboard's live chat tail does not follow OpenCode sessions, and token totals read as zero.

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

   - Codex CLI: use `harness: codex` ([Codex](#codex)), which writes this registration for you
     and adds the hooks. To register by hand, put it in the workspace's `.codex/config.toml`
     (Codex reads it once the folder is trusted) and start Codex with the workspace's token,
     `WERKMEISTER_MCP_TOKEN=$(cat .werkmeister/token) codex`:

     ```toml
     [mcp_servers.werkmeister]
     url = "http://127.0.0.1:3002/mcp"
     # The workspace token scopes the session to this workspace; unset, Codex skips the server.
     bearer_token_env_var = "WERKMEISTER_MCP_TOKEN"
     # Headless `codex exec` refuses tools that write unless the server is pre-approved,
     # and its 300 s default cuts off a first `up` while the worktree installs.
     default_tools_approval_mode = "approve"
     tool_timeout_sec = 1800
     ```

     A global registration (`codex mcp add werkmeister --url http://127.0.0.1:3002/mcp`,
     which writes `~/.codex/config.toml`) has no token, so every Codex session on the machine
     acts as the host (step 1). Leave `default_tools_approval_mode` out there: pre-approved,
     any session could run `close-out`, `down` or a Jira or GitHub write against any workspace
     without a prompt.

   - Cursor: `.cursor/mcp.json` in the workspace:

     ```json
     { "mcpServers": { "werkmeister": { "url": "http://127.0.0.1:3002/mcp" } } }
     ```

   - GitHub Copilot CLI: `/mcp add`, type HTTP, the same URL.

   A harness running **inside a container** sends the workspace's token instead:
   `Authorization: Bearer $(cat .werkmeister/token)` (Codex: `bearer_token_env_var`),
   which scopes it to that one workspace. The devcontainer `workspace init` generates
   does this for Claude Code, and only on a `harness: claude` workspace: on `mcp`, `codex`
   and `opencode` it writes none and removes one it generated before.
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

## The agent-state record

Every harness's hooks call `werkmeister internal agent-state`, which keeps one record per
session in `.werkmeister/sessions/<session id>.json` (SW-487): busy or idle, the open tool
call, running subagents, and what the session is waiting on the person for (a question, a
permission or a plan). One file per session means a second session, a headless wake turn or a
subagent can't overwrite another session's ask. A busy session silent for 30 minutes with no
open process reads as **Session gone**. werkmeister-core's `workspaceState` builds the card's
phase, activity and Needs-you list from these records and the workspace's other facts.

On Claude Code the hook also listens to `PermissionRequest`, `PermissionDenied`,
`PostToolUseFailure`, `SubagentStart`, `SubagentStop` and `StopFailure`. New workspaces get them
from `workspace init`. For an existing one, run `werkmeister machine migrate`: it rewrites a
workspace's agent-state hooks when any of these events is missing. Until then the card still
works from the older events, without subagent activity.

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
  last line, as on Claude Code. Codex sends none of the SW-487 events (PermissionDenied,
  subagents, StopFailure), so its card shows no subagent activity.
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

## OpenCode

1. Install OpenCode 2.x with its v2 installer (`--no-modify-path` leaves your shell profile alone;
   the binary lands in `~/.opencode/bin/opencode`). The opencode.ai/install script installs 1.x,
   and `brew install opencode` builds from source where no bottle exists. Then log in to a model
   provider once with `opencode auth login`, run in a real terminal: it is an interactive picker and
   saves nothing when run without a TTY (an agent's shell, a `!` prompt).
2. Create the workspace for it: `werkmeister workspace new my-feature --harness opencode …`
   (or `harness: opencode` in `workspace.yml`, or `WERKMEISTER_HARNESS=opencode`). `workspace init`
   writes `AGENTS.md`, `.agents/skills/`, the plugin `.opencode/plugins/werkmeister.js` and the
   `werkmeister` MCP server in `opencode.json` (other keys in an existing file are kept; a file that
   isn't plain JSON is left alone with a warning).
3. Run `opencode` in the workspace folder. The plugin loads on OpenCode 1.x and 2.x (it exports both
   plugin APIs) and sends each tool call, prompt and session event to `werkmeister internal gate`,
   `pr-guard` and `agent-state`, so the Workspaces pane shows working / needs you / done.
4. A `model:` in `workspace.yml` reaches headless turns (`claude-send` on this workspace) only in
   OpenCode's `provider/model` form; a Claude alias like `sonnet` is left to OpenCode's own config.
   A tier resolves through `models.opencode` (built-in frontier: `anthropic/claude-opus-5-5`); Codex
   has no built-in tiers, so set `models.codex.<tier>` in `~/.werkmeister/config.yaml` (configuration
   § `~/.werkmeister/config.yaml: models`).

`opencode.json` also gets werkmeister's MCP server with this workspace's token
(`Bearer {file:.werkmeister/token}`), and `permission.bash` deny rules for shared infra, other
workspaces, global installs and `gh pr merge` (the list Claude's unattended turns get). They hold in
your own OpenCode sessions in the workspace too; run those commands from a terminal.

Checked on OpenCode 2.2.5 (SW-385): it loads the plugin through its V2 `setup`; its shell tool is
`shell` and its file tools `write` / `edit` pass `path`; a turn ends with
`session.execution.succeeded`, which the plugin sends as Stop. A headless `opencode run` exits before
that Stop call finishes, so for turns werkmeister started (`claude-send`) the card reads done from the
turn runner instead. `session export <id>` gives the transcript. The permission-prompt event name
(needs you) is from OpenCode's docs and not yet seen on 2.2.5.

OpenCode has no session-end event: a session quit mid-turn reads as working until its record goes
stale (24 h), and auto-stop does not run.

## Adding a harness adapter

A harness with its own hooks gets its own layout under
`packages/werkmeister-core/src/harness/<id>/` (`HarnessLayout` in
`harness/types.ts`), registered in `harness/layout.ts`, with its hooks writer
mapping werkmeister's hook events to the harness's file and payload. A harness with
sessions also implements `HarnessAdapter` (`harness/types.ts`) and adds it to
`harnessFor`'s registry in `harness/layout.ts`; `harness/codex/adapter.ts` is the example. The Claude
Code adapter in `harness/claude/` is the reference. The Codex adapter in `harness/codex/` shows the
small case: it reuses `harness/claude/hooks_gen.ts`'s merge with its own file and event map.
