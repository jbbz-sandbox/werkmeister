# UI spec: one experience across the Werkmeister surfaces

The rules every Werkmeister UI follows: the words, the card, the actions, the create form, and the one MCP server behind them. The visual design (tokens, layout, states) is in [`design/workspace-card/`](design/workspace-card/README.md); where the two disagree, this file wins.

Origin: the ui-surfaces spike, tracked in Jira [SW-43](https://jory-group.atlassian.net/browse/SW-43). Implementation issues: SW-46 – SW-57.

## Surfaces

| Surface | Code | Renders with | Density |
|---|---|---|---|
| **Dashboard** | `apps/werkmeister-dashboard` (browser page, `werkmeister internal dashboard`) | DOM | full |
| **MCP App** | the same modules, served as `ui://` resources inside Claude Desktop | DOM, host theme | full (≤720px) |
| **Pane** | `plugins/werkmeister/hooks/register.tsx` | Claude Code's `Box` / `Text` / `Button` | compact |
| **VS Code** | `packages/werkmeister-vscode` | native TreeView: label, description, Markdown tooltip, codicons | compact |

## Decisions

| Decision | Date |
|---|---|
| **One spec, two densities.** Full and compact show the same fields, words and colour meanings; compact uses fewer pixels. | 2026-10-16 |
| **Shared spec, not one shared component.** The pane and VS Code can't render DOM, so they share a non-DOM **display model** (workspace data → label, tone, glyph, primary action) in `packages/werkmeister-ui`. The two DOM surfaces also share components. | 2026-10-16 |
| **React is the UI library.** `packages/werkmeister-ui` and the dashboard tabs are React; the vanilla-DOM helpers (`el()` / `injectCss()`) are gone (SW-57), and each component's stylesheet is a React-hoisted `<style>` (`Css`, `style.tsx`). React is bundled inline (`viteSingleFile`, no CDN), so the strict CSP holds. Moving VS Code to a webview is a separate, open decision. | 2026-10-17 |
| **One MCP server**, `apps/werkmeister-mcp`, with one name per verb. No backward compatibility for tool names. | 2026-10-16 |
| **Containers may call every MCP tool.** There is no host-only tier; the bearer token is the only gate. | 2026-10-16 |
| **No Remove.** The only destructive verbs are Close out and Abandon…. `remove-workspace` is deprecated in favour of `close-out --abandon` (#160). | 2026-10-16 |
| **Pane buttons grouped by what they act on** (session · containers · work); `⇆ Open beside` replaces `↗ Continue in Desktop` on the pane (SW-105). | 2026-10-26 |
| **Pane: `▶ Start work`** starts a fresh workspace's run in a Desktop session with the title, model, prompt and run limits werkmeister-core builds (SW-153). | 2026-10-28 |
| **`▶ Start work` falls back to this session.** When the pane's own `start_session` call is refused (always, in auto mode), the pane drafts a message in this session's prompt box asking its model to make the same call with the same arguments; the person's Enter sends it. The app starts a session only on the person's own turn, never on one a plugin submits (SW-157). | 2026-10-28 |

## Rules

1. **Every count names its unit:** `2 of 3 up`, never `2/3`.
2. **Colour is never the only carrier.** Every colour sits next to a word or glyph that says the same thing. WCAG AA in light and dark.
3. **One colour scale:** green ok · amber partial or attention · red failing · grey off. Purple only for Merged / Released. The accent colour never carries status.
4. **The highlight means one thing:** an amber border and header mean **Needs you**. Container state is in words, not in the border.
5. **One legend per surface:** dashboard footer or help popover, MCP App footer, pane `?` toggle, VS Code welcome or help view.
6. **One verb per action**, the same on every surface (§ Actions).
7. **A loading state for every row**, so cards don't jump.

## The card

A person must tell, at a glance, for each workspace:

| Question | Row | Canonical text |
|---|---|---|
| Are the containers healthy? | **Containers** | `N of M up`, `paused` or `down`, then one item per service: `● name` up · `○ name` down · `◐ name starting` · `▲ name unhealthy`. Docker unreachable: `Docker unreachable · retry` |
| What PRs exist? | **PRs** | `repo#N` link, state badge, CI badge. `None yet`. Lookup failed: `PRs unavailable · retry` |
| Where is the run? | **Workflow** | `Stage n of m · name` (ICM), `JIT · phase`, or the lifecycle step: `Ready to open PR` · `Awaiting release` · `Ready to close out` · `Closed out` · `Abandoned` |
| What is the agent doing? | **Agent** + header chip | `◌ Working` · `● Needs you` · `✓ Done` · `Idle`, plus a time (`asked a question 12 min ago`). `⏸ Paused` (`paused 12 min ago`) replaces all four while the workspace is paused. `⚙ Autonomous` (compact: `⚙ Auto`) when the run is autonomous |

- **Header:** name, agent chip, autonomous badge; then the work-type tag and the **task title from `workspace.yml`** (never the session title or a slice of the starting prompt); then the issue as `owner/repo#123`.
- **Needs you** cards show the last question in the header, with the primary action.
- The agent state comes from the persisted signal of SW-46, not from "the assistant spoke last".
- Compact: name + chip on one line, then `containers 2 of 2 up · PRs werkmeister#231 Draft · CI running · stage 4/5 implement`. VS Code: label = name, description = `● Needs you · 2 of 2 up · stage 2/4 · #143`, tooltip = the four rows.

### Data

Every row reads werkmeister-core; no surface computes its own. The shapes and their edge cases are the TSDoc on `WorkspaceStatus` and `RepoPr` (`packages/werkmeister-core/src/sandbox.ts`).

| Row | Field |
|---|---|
| **Containers** | `getWorkspaceStatuses()` → `state`, `running` / `total`, and per-service health `services[] {name, state}` (`healthy` · `starting` · `unhealthy` · `running` · `down`) |
| **PRs** | `getWorkspacePRs()` → per repo `url`, `state`, `ci` (`pass` · `running` · `fail` · null = no checks) and `failingChecks` |
| **Workflow** | `stage {index, total, name}` (ICM) · `phase` (JIT, from the newest note) · `lifecycleOf()` for the lifecycle step |
| **Agent** | `claude {state, agent, at, question}` (agent from the hooks' `agent-state.json`, SW-46), `lastActivity` (newest transcript's mtime), `autonomous`, `autoStop`, `model` |

### Badges

| Concept | Canonical | Tone |
|---|---|---|
| PR state | `Open` · `Draft` (dashed) · `Merged` · `Released vX.Y.Z` · `Closed` | ok · off · pr · pr · off |
| CI | `CI ✓` · `CI running` · `CI ✗ N failing` | ok · warn · err |
| Issue / PR link | `owner/repo#123`; a card may drop the owner for the default org (`werkmeister#231`) | info |
| Containers summary | all up · some up · none up · unknown | ok · warn · off · off |
| Paused | `⏸ Paused` (agent chip, replaces Needs you / Working / Done / Idle) | off |

## Actions

| Action | Text | Dashboard | MCP App | Pane | VS Code |
|---|---|---|---|---|---|
| Start containers | `▶ Up` | ✓ | ✓ | ✓ | ✓ |
| Stop / restart / tear down | `■ Stop` · `↻ Restart` · `⏻ Down` | ✓ | ✓ | ✓ | ✓ |
| Pause / resume | `⏸ Pause` · `▶ Resume` | ✓ | ✓ | ✓ | ✓ |
| Continue a session | `↗ Continue in Terminal` · `↗ Continue in Desktop`; Pane: `⇆ Open beside` for a Desktop session, `↗ Continue in Terminal` · `↗ Continue in VS Code` otherwise | ✓ | ✓ | ✓ | Terminal |
| New session | `＋ New session` | ✓ | ✓ | ✓ | ✓ |
| Start the run | `▶ Start work` | ✗ | ✗ | ✓ | ✗ |
| Refresh PRs | `↻ Refresh PRs` | ✓ | ✓ | ✓ | ✓ |
| Open the feature | `Open feature ↗` | ✓ | ✓ | ✓ | ✓ |
| Open the issue | `Open issue ↗` | ✓ | ✓ | ✓ | ✓ |
| Logs | `Logs` | ✓ | ✓ | ✓ | ✓ |
| Connect infra | `⚡ Connect infra` (top bar) | ✓ | ✓ | ✓ | ✓ |
| Create | `＋ New workspace` | ✓ | ✓ | ✓ | ✓ (terminal wizard) |
| Pin | `📌 Pin` | ✗ | ✗ | ✓ | ✗ |
| Bring into view | `→ Switch to` | ✗ | ✗ | ✓ | ✓ |
| Filter to `focus`-labelled | `☐ Focused only` | ✓ | ✓ | ✓ | ✗ |
| Finish settled work | `✓ Close out` | ✓ | ✓ | ✓ | ✓ |
| Stop unsettled work | `✕ Abandon…` | ✓ | ✓ | ✓ | ✓ |

✗ = the platform can't (a browser page or MCP iframe can't drive Claude Code panes or start a Desktop session; VS Code has no pin or split for folders). Desktop sessions can't be reached from VS Code.

On the dashboard and MCP App, `↗ Continue in Desktop` opens the workspace folder in Desktop (`claude://code/new?folder=…`): a browser page or MCP iframe can't read the app's session list, so it can't link the previous Desktop session. `＋ New session` there opens a fresh `claude` in Terminal (`claude-resume` with `new: true`).

**Primary action:** Paused → `▶ Resume` · Needs you → `↗ Continue in …` · Ready to close out → `✓ Close out` · containers down → `▶ Up` · otherwise `↗ Continue in …` (`＋ New session` when there is no session). Pane: `▶ Start work`, unless ready to close out, when there is no session and the first stage has no output.

**Dashboard, MCP App, VS Code:** the bar shows the primary plus two secondaries: `■ Stop` · `⏸ Pause` while containers run (`↻ Restart` moves to `⋯`), `■ Stop` · `⏻ Down` while paused. Everything else goes in `⋯`, in this order: Pin · ↻ Refresh PRs · Open feature ↗ · Open issue ↗ · Logs · ✕ Abandon….

**Pane:** no `⋯`. One labelled row per group, each wrapping within itself on a narrow card; buttons that don't apply are hidden, and the primary is highlighted where it sits.

| Group | Buttons, in order |
|---|---|
| `session` | `⇆ Open beside` (Desktop; tries the split, else opens the session in this chat's place and toasts how to split it) or `↗ Continue in Terminal` / `VS Code` · `▶ Start work` (no session, first stage with no output) · `＋ New session` · `📌 Pin` |
| `containers` | `▶ Resume` or `▶ Up` · `■ Stop` · `⏸ Pause` · `↻ Restart` · `⏻ Down`, then on a second line, while containers run, `Logs` (a Terminal window following them) · `Open feature ↗` |
| `work` | `↻ Refresh PRs` · `Open issue ↗` · `✓ Close out` · `✕ Abandon…` |

### The two destructive verbs

Both confirm inline in the card footer, never in a modal (VS Code: a modal warning message is its only option).

| Verb | Does (`closeOut`, `packages/werkmeister-core/src/pr_lifecycle.ts`) | Confirm |
|---|---|---|
| `✓ Close out` | Every PR shipped, closed or abandoned: moves the issue to Done with a "Shipped" comment, writes `closeout.md`, removes the workspace, deletes the merged branches | one step: `✓ Yes, close out` |
| `✕ Abandon…` | The work stops unsettled: posts "Abandoned: `<reason>`" on the issue and moves it to the abandoned status, pushes and keeps every branch with commits of its own, removes the workspace | a required reason, then `✕ Yes, abandon` |

## The create form

One form on every surface, built from `_WIZARD_PROMPTS` (`packages/werkmeister-core/src/workspace_prompts.ts`): a GUI on the dashboard, MCP App and pane, the terminal wizard in VS Code. GUI labels carry no terminal hints ("blank to skip", "Enter for default").

| Field | GUI label | Widget | Required | Default |
|---|---|---|---|---|
| `issue_id` | Issue | text + `⤓ Fill from issue` | no | empty |
| `feature` | Feature name | text, `^[a-z0-9]+(-[a-z0-9]+)*$` | yes | empty |
| `work_type` | Work type | select: feature, bugfix, incident, refactor, spike | yes | **feature** |
| `context_strategy` | Workflow | segmented: ICM (staged) / JIT | no | **icm** |
| `autonomous` | Autonomous run | toggle | no | off |
| `model` | Model | text, placeholder `sonnet`; help names the aliases | no | empty (Claude Code's default) |
| `auto_stop` | Auto-stop on session end | toggle | no | off |
| `services` + `repos` | Services to run locally · Extra repos | checkboxes grouped by repo | at least one service **or** repo, on every surface including the wizard | none |
| `labels` | Labels | chip input | no | empty |
| `test_path` | Feature test path | text, must start with `/` | no | empty |
| `task` | Task title | text; help "Defaults to the feature name in words." | no | empty |
| `description` | Description | text | no | empty |
| `starting_prompt` | Starting prompt | textarea + `✨ Refine with Claude` | no | empty |

Defaults that don't depend on the current directory (`work_type`, `context_strategy`) are preselected in every GUI. The VS Code wizard runs from the workspaces root, not `~`. Submit: `＋ Create workspace` → `Creating…` → a link to the new card.

## One MCP server

`apps/werkmeister-mcp` (server `werkmeister`) is the only MCP server, and `plugins/werkmeister/.mcp.json` launches it. The dashboard's server (`workspaces`, `apps/werkmeister-dashboard/src/server.ts`) is gone; the dashboard keeps only its localhost browser page and the `--browser-form` page, and its `/api/tool` calls `apps/werkmeister-mcp`'s `createServer()` in process. Both transports carry every tool: stdio (`werkmeister internal mcp`) and HTTP :3002 with the bearer token. Details: SW-48. <!-- docs-check: ignore -->

| Merged tool | `workspaces` (dashboard) today | `werkmeister` (apps/werkmeister-mcp) today |
|---|---|---|
| `list-workspaces` (App UI) | `list-workspaces` | `list-workspaces` |
| `create-workspace-form` (App UI) + `create-workspace` | `workspace`, `create-workspace` | `workspace` |
| `status` | `workspace-status` | `status` <!-- docs-check: ignore --> |
| `up` · `stop` · `restart` · `down` · `pause` · `resume` | `workspace-action` | `up` · `stop` · `restart` · `down` · `pause` · `resume` |
| `close-out` | `close-out` | `close-out` |
| `connect` | `sandbox-connect` | `connect` | <!-- name-check: ignore -->
| `open-feature` | `open-feature` | `open` |
| `remove-service` (drops one service to k8s) | — | `remove` |

Every other tool keeps its name. Tools only the UI calls are marked `_meta.ui.visibility: ["app"]`: `workspace-form-schema`, `issue-form-data`, `refine-prompt`, `issue-statuses`, `claude-turn-status`. Tools take one `workspace` argument; the `X-Werkmeister-Feature` header stays the container default.
