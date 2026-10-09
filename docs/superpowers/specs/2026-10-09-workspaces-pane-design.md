# Workspaces pane for the Claude Code desktop app

A Claude Code mod in the `sandbox-tools` plugin that shows every sandbox
workspace in a docked pane, with the lifecycle controls the VS Code extension
offers, plus two things only the desktop app can do: point this session at a
workspace, and jump to the desktop session already open there.

## Goal

From a Claude Code desktop session, see the workspaces under
`paths.workspaces_root` with their container state, start/stop/restart/down any
of them, remove one, switch this session into a workspace's folder, and open the
desktop session whose working directory is that workspace. No terminal, no
browser tab, no `sandbox` subcommand typed by hand.

## Not in scope

Telepresence intercepts, log tailing, Jira links, open-in-VS-Code, the workspace
creation form, token usage. All of these have a sandbox-core payload or an MCP
tool already and can be added to the pane later without changing its shape.

## Where it lives

```
plugins/sandbox-tools/
  .claude-plugin/plugin.json   add "types": "./types/index.d.ts"
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           the mod
  hooks/register.test.ts       claude plugin test
  types/index.d.ts             PluginState contract
```

These are the paths the removed `/workspace-form` mod used (commit cb27087), so
`hooks.json` and the `types` field are restored, not invented. During
development the mod is written to this session's hot-reload mods folder and
moved into the plugin once the probe passes.

The mod runs in the plugin's sandboxed module environment: no Node, no DOM.
Everything outside it goes through `$`.

## Data

All reads and writes go through MCP servers the session already has connected.
The mod never shells out.

| Need | Call | Fields used |
|---|---|---|
| Workspace list | `$.mcp.call('sandbox-workspace', 'list-workspaces')` | `workspaces[].name`, `path`, `jiraId` |
| Container state | `$.mcp.call('sandbox-workspace', 'workspace-status')` | `statuses[].name`, `state`, `running`, `total`, `claude.state`, `claude.waiting` |
| Desktop sessions | `$.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 50 })` | `sessionId`, `title`, `cwd`, `link`, `isRunning` |
| Lifecycle | `$.mcp.call('sandbox-workspace', 'workspace-action', { name, action })` | `action` in `up`, `stop`, `restart`, `down` |
| Remove | `$.mcp.call('sandbox-workspace', 'remove-workspace', { name })` | |
| Switch | `$.mcp.call('ccd_directory', 'change_directory', { path })` | |

Each result is read from `structuredContent`; a result with `isError` is shown
as the row's status text and does not clear the last good data.

A workspace's desktop session is the session whose `cwd` equals the workspace
path or lies inside it, deepest match winning. This is the extension's
`currentWorkspaceName` rule inverted. Where several sessions match, the most
recently active one is shown.

### Polling

The pane polls every 5 seconds with `$.clock.every` while open. The timer starts
in the `command.run` hook that opens the pane and is cancelled by a `ui.close`
hook on the pane id. A tick that starts while the previous one is still running
is skipped, never queued. Session list and workspace list are fetched in
parallel; a failed session lookup must not cost the workspace list.

### State

Everything a drawing reads lives in `$.state` under `sandbox-tools`, so a hot
reload does not blank the pane:

```ts
interface PluginState {
  'sandbox-tools': {
    rows: WorkspaceRow[]        // joined list + status + session
    error: string               // last fetch error, '' when none
    busy: string                // workspace name an action is running on, '' when none
    confirmRemove: string       // workspace name awaiting the second Remove press
    note: string                // last action result, shown under the list
  }
}
```

`WorkspaceRow` carries name, path, jiraId, state, running, total, claude state
and waiting flag, and an optional `session: { id, title, link }`.

## The pane

Opened by the slash command `/workspaces`. Opened by a command it seats at any
width, so there is no unasked open from `session.start`.

One block per workspace:

```
● feature-x   PROJ-123   3/3   claude: waiting
  [Stop] [Restart] [Down] [Switch] [Remove]   session: Workspace-form debugging
```

- The dot is `●` for up, `◐` for partial, `○` for stopped and down, `?` for
  unknown. Colour follows the surface theme where the element table allows it.
- The counts are `running/total`, omitted when total is 0.
- The Claude note is `working` when `claude.state` is `running`, `waiting` when
  `claude.waiting`, otherwise absent.
- Buttons follow the extension's `when` clauses: Up shows for down, stopped and
  partial; Stop shows for up and partial; Restart, Down, Switch and Remove
  always show.
- The session entry is a `Link` whose `href` is the session's `claude://` link
  and whose label is its title. It is absent when no desktop session matches.
- While `busy` names this workspace, its buttons are replaced by the text
  `working…`.

Below the list: `note` when non-empty, `error` when non-empty, and a `Refresh`
button.

### Actions

Every button press arrives at one `ui.press` hook matched on the plugin. The
element key is `<action>:<name>`.

- `up`, `stop`, `restart`, `down`: set `busy`, call `workspace-action`, write the
  result's first line to `note`, clear `busy`, trigger a refresh. A press while
  `busy` is set is ignored.
- `switch`: call `change_directory` with the workspace path and toast
  "Switching to <name> when this turn ends", which is what the tool promises.
- `remove`: first press sets `confirmRemove` to the name and the button relabels
  to `Confirm remove`; a press on any other workspace's button clears it. The
  second press calls `remove-workspace` the way lifecycle actions run. This
  tool commits, pushes, tears down and deletes, so one accidental press must
  never reach it.
- `refresh`: run a tick now.

## Error handling

- Either MCP server missing: `error` says which, the list keeps its last rows.
- A tool result with `isError`: its text becomes `note` for an action, `error`
  for a read. Nothing is retried automatically; the next tick retries reads.
- `change_directory` refused (see Unknowns): `note` carries the refusal and the
  toast tells the user the fallback command.
- A tick that throws is logged with `$.ui.log` and does not stop the timer.

## Unknowns, resolved first

Two behaviours the plugin API docs do not settle. The first implementation task
is a throwaway probe mod that answers both before the real mod is written.

1. **Does `change_directory` answer a plugin's `$.mcp.call`?** The API says a
   plugin's `mcp.call` needs no permission prompt. But commit 1500cb1 found the
   desktop's browser tools answer only calls the model makes, and the directory
   tools may be gated the same way, since the app shows the user the folder to
   approve.
2. **Does a `claude://` `Link` in a desktop pane focus that session?** The link
   is what `list_sessions` hands out for use outside the app. Whether the pane
   surface opens it, and whether opening it switches the main pane, is untested.

Fallbacks, chosen per unknown if it fails:

1. Switch becomes a registered command `/workspaces switch <name>` whose
   `command.run` hook returns `{ text }` asking the model to call
   `change_directory`; the button toasts that command.
2. The session entry becomes plain text naming the session, and a `Jump`
   button calls `open_session_in` with `target: focus`, which works only for
   sessions this one started; otherwise it toasts the title so the user can
   click it in the sidebar.

## Testing

`hooks/register.test.ts`, run by `claude plugin test`, with `$.mcp.call`
stubbed:

- Rendering: three stubbed workspaces in up, partial and down states draw three
  rows with the right dot, counts and button set.
- Session join: a session whose `cwd` is a child of a workspace path attaches
  to that workspace; one in an unrelated folder attaches nowhere.
- Remove gating: one press changes the label and calls nothing; a second press
  calls `remove-workspace` once; a press on another row's button in between
  resets the label.
- Busy gating: a lifecycle press while `busy` is set calls nothing.
- Close: `ui.close` cancels the timer.

`claude plugin validate plugins/sandbox-tools` and `tsc -p plugins/sandbox-tools`
pass. The probe mod's findings are recorded in the plugin README under the
pane's section, with the fallback that was taken, if any.

## Install and sharing

Nothing new. The plugin is already installed from this repo's marketplace;
`claude plugin update` or a session restart picks the mod up. The README gains a
`/workspaces` row in the skills table and a short section on the pane.
