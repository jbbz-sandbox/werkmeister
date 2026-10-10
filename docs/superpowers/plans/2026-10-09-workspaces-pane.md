# Workspaces Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/workspaces` pane in the Claude Code desktop app listing every sandbox workspace with up/stop/restart/down/remove controls, a Switch button that moves this session into the workspace, and a link to the desktop session open there.

**Architecture:** One hooks module in the `sandbox-tools` plugin. All data comes from MCP servers the session already has (`sandbox-workspace` for workspaces and actions, `ccd_session_mgmt` for desktop sessions, `ccd_directory` for Switch) through `$.mcp.call`; the module never shells out. Rows live in `$.state` and a `$.clock.every` timer refreshes them while the pane is open.

**Tech Stack:** Claude Code plugin hooks module (TypeScript/JSX against the `claude-code` types), `claude plugin test` with the `claude-code/testing` kit, `claude plugin validate`, `tsc`.

**Spec:** `docs/superpowers/specs/2026-10-09-workspaces-pane-design.md`

## Global Constraints

- Plugin name is `sandbox-tools`; every `$.state` reference uses `{ plugin: 'sandbox-tools', key }` and every key is declared in `types/index.d.ts`.
- The pane id is `workspaces`; the command is `/workspaces`; the pane title is `Sandbox workspaces`.
- Workspace MCP server name is `sandbox-workspace`; session server is `ccd_session_mgmt`; directory server is `ccd_directory`.
- Button keys are `<action>:<name>` where action is one of `up`, `stop`, `restart`, `down`, `switch`, `remove`; the refresh button key is `refresh`.
- Poll interval is 5000 ms. An overlapping tick is skipped, never queued.
- Remove needs two presses on the same workspace; a press on any other workspace's button clears the pending confirm.
- No Node APIs in the module: no `fs`, `child_process`, `process`, `setInterval`. Only `$`.
- Tests loop over `['terminal', 'desktop'] as const` for every mount.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A `list_sessions` result that comes back as a JSON text block with no `structuredContent` must still populate session links (Task 3 test "sessions from text block").
2. A workspace whose path is a prefix of another's (`/ws/ab` and `/ws/abc`) must not claim the other's session (Task 3 test "segment-aware join").
3. A `workspace-status` row with `total` 0 must draw no counts, not `0/0` (Task 3 test "no counts when total is 0").
4. A lifecycle press while another workspace is busy must be ignored, not queued (Task 4 test "press while busy is ignored").
5. Closing the pane from the engine's `unload` origin must still cancel the timer, otherwise a hot reload leaks a poll (Task 7 test "unload cancels the timer").

---

### Task 1: Probe the two unknowns (throwaway)

The spec names two behaviours the API docs do not settle. Answer both before writing the real mod. Nothing from this task is committed to the repo.

**Files:**
- Create: `/Users/jayboyer/.claude/dev-mods/5a39f4f2-f7af-47c0-8159-a5622386168e/probe/.claude-plugin/plugin.json`
- Create: `/Users/jayboyer/.claude/dev-mods/5a39f4f2-f7af-47c0-8159-a5622386168e/probe/hooks/hooks.json`
- Create: `/Users/jayboyer/.claude/dev-mods/5a39f4f2-f7af-47c0-8159-a5622386168e/probe/hooks/register.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: two yes/no findings that select the Switch and session-link implementations in Task 6.

- [ ] **Step 1: Write the probe mod**

`.claude-plugin/plugin.json`:

```json
{ "name": "probe", "version": "0.1.0", "description": "Throwaway probe for change_directory and claude:// links" }
```

`hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

`hooks/register.tsx`:

```tsx
import type { Register } from 'claude-code'

const PANE = 'probe'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'probe', description: 'Probe change_directory and claude:// links' })
    return next(e)
  })

  on('command.run', { command: 'probe' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Probe' })
    return { text: 'Probe pane opened.' }
  })

  on('ui.press', { plugin: 'probe', element: 'cd' }, async ($, e, next) => {
    try {
      const r = await $.mcp.call('ccd_directory', 'change_directory', { path: '/Users/jayboyer/features' })
      const text = r.content.map(c => (c.type === 'text' ? c.text : c.type)).join(' ')
      $.ui.toast(`change_directory: isError=${r.isError} ${text}`.slice(0, 300))
    } catch (err) {
      $.ui.toast(`change_directory threw: ${(err as Error).message}`.slice(0, 300))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 3 })
    const text = r.content.map(c => (c.type === 'text' ? c.text : '')).join('')
    let sessions: { title: string; link?: string }[] = []
    try { sessions = JSON.parse(text) } catch { /* shown below as raw text */ }
    return (
      <Box flexDirection="column">
        <Button key="cd" label="change_directory to ~/features" variant="primary" />
        {sessions.map(s => (s.link ? <Link href={s.link} label={`open: ${s.title}`} /> : <Text>{s.title}</Text>))}
        {sessions.length === 0 && <Text dimColor>{text.slice(0, 400)}</Text>}
      </Box>
    )
  })
}
```

- [ ] **Step 2: Enable hot reload and run the probe**

Writing the files makes the engine ask "Enable hot reloading for this session?". Answer "Enable for this session". When the turn ends the mod loads. Then type:

```
/probe
```

- [ ] **Step 3: Record finding 1 (change_directory)**

Press the "change_directory to ~/features" button. Record which of these happened:

- The app asks to approve the folder, and after approval the toast says `isError=false`: **finding 1 = yes**.
- The toast says `isError=true` or `threw`, or nothing happens: **finding 1 = no**.

If the session's directory actually moved, move it back with the `change_directory` tool pointed at `/Users/jayboyer/repos/sandbox`.

- [ ] **Step 4: Record finding 2 (claude:// link)**

Click one of the `open: <title>` links. Record which happened:

- The app's main pane switches to that session: **finding 2 = yes**.
- Nothing happens, or an external handler is asked: **finding 2 = no**.

Also note whether the link rendered as a link at all. The `Link` doc says a remote surface draws anything but `https:` as plain text, so **finding 2 = no** is expected; the probe confirms it.

- [ ] **Step 5: Remove the probe**

```bash
rm -rf /Users/jayboyer/.claude/dev-mods/5a39f4f2-f7af-47c0-8159-a5622386168e/probe
```

Write the two findings into the plan's Task 6 before continuing (edit the two `FINDING` lines there).

---

### Task 2: Plugin scaffolding, state contract, empty pane

**Files:**
- Modify: `plugins/sandbox-tools/.claude-plugin/plugin.json` (add `"types"`)
- Create: `plugins/sandbox-tools/hooks/hooks.json`
- Create: `plugins/sandbox-tools/types/index.d.ts`
- Create: `plugins/sandbox-tools/hooks/register.tsx`
- Create: `plugins/sandbox-tools/hooks/register.test.ts`

**Interfaces:**
- Produces: the `WorkspaceRow` type, the state refs `ROWS`, `ERROR`, `BUSY`, `CONFIRM`, `NOTE`, the constants `PLUGIN`, `PANE`, `SERVER`, `POLL_MS`, and the test helper `world(on)` that stubs every noun the module calls. Every later task adds hooks to this same `register` function and tests to this same test file.

- [ ] **Step 1: Write the state contract**

`plugins/sandbox-tools/types/index.d.ts`:

```ts
export type WorkspaceState = 'up' | 'partial' | 'stopped' | 'down' | 'unknown'

export type WorkspaceRow = {
  name: string
  path: string
  jiraId: string | null
  state: WorkspaceState
  running: number
  total: number
  claude: 'working' | 'waiting' | null
  session: { id: string; title: string; link: string | null } | null
}

declare module 'claude-code' {
  interface PluginState {
    'sandbox-tools': {
      rows: WorkspaceRow[]
      error: string
      busy: string
      confirmRemove: string
      note: string
    }
  }
}
```

- [ ] **Step 2: Write the manifest changes**

`plugins/sandbox-tools/hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

In `plugins/sandbox-tools/.claude-plugin/plugin.json` add one line after `"mcpServers": "./.mcp.json"`:

```json
  "mcpServers": "./.mcp.json",
  "types": "./types/index.d.ts"
```

- [ ] **Step 3: Write the failing test**

`plugins/sandbox-tools/hooks/register.test.ts`:

```ts
import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const PANE_PROPS = {
  title: 'Sandbox workspaces',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type McpAnswer = { content: { type: 'text'; text: string }[]; isError: boolean; structuredContent?: unknown }
type McpStub = Record<string, (args: Record<string, unknown>) => McpAnswer>

/** Stubs every noun the module calls. `calls` records each mcp.call as `server/tool`. */
function world(on: On, stubs: McpStub = {}) {
  const calls: { key: string; args: Record<string, unknown> }[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('mcp.call', (_$, e) => {
    const key = `${e.server}/${e.tool}`
    calls.push({ key, args: e.args })
    const stub = stubs[key]
    if (!stub) return { value: { content: [{ type: 'text' as const, text: `no stub for ${key}` }], isError: true } }
    return { value: stub(e.args) }
  })
  return { calls, toasts, clock }
}

function ok(structuredContent: unknown, text = 'ok'): McpAnswer {
  return { content: [{ type: 'text', text }], isError: false, structuredContent }
}

async function openPane($: Engine) {
  await $.command.run({ command: 'workspaces', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

test('empty list draws the empty message', async ($, on) => {
  world(on, {
    'sandbox-workspace/list-workspaces': () => ok({ root: '/ws', workspaces: [] }),
    'sandbox-workspace/workspace-status': () => ok({ statuses: [], infra: { state: 'down', running: 0, total: 0, services: [] } }),
    'ccd_session_mgmt/list_sessions': () => ok(undefined, '[]'),
  })
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect((await ui.find({ text: /No workspaces/ }))?.text).toMatch(/No workspaces/)
    await ui.unmount()
  }
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `claude plugin test plugins/sandbox-tools`
Expected: FAIL. The module does not exist, so no hook answers `command.run` and the mount draws nothing matching.

- [ ] **Step 5: Write the module skeleton**

`plugins/sandbox-tools/hooks/register.tsx`:

```tsx
import type { Register, EngineInterface } from 'claude-code'

import type { WorkspaceRow } from '../types'

export const PLUGIN = 'sandbox-tools'
export const PANE = 'workspaces'
export const SERVER = 'sandbox-workspace'
export const POLL_MS = 5000

const ROWS = { plugin: PLUGIN, key: 'rows' } as const
const ERROR = { plugin: PLUGIN, key: 'error' } as const
const BUSY = { plugin: PLUGIN, key: 'busy' } as const
const CONFIRM = { plugin: PLUGIN, key: 'confirmRemove' } as const
const NOTE = { plugin: PLUGIN, key: 'note' } as const

/** Refreshes rows once. Filled in by Task 3; here it only clears the list. */
async function tick($: EngineInterface): Promise<void> {
  await $.state.set(ROWS, [])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'workspaces', description: 'Open the sandbox workspaces pane' })
    return next(e)
  })

  on('command.run', { command: 'workspaces' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sandbox workspaces' })
    await tick($)
    return { text: 'Workspaces pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: rows = [] } = await $.state.get(ROWS)
    const { value: error = '' } = await $.state.get(ERROR)
    const { value: note = '' } = await $.state.get(NOTE)

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No workspaces.</Text>}
        {note !== '' && <Text>{note}</Text>}
        {error !== '' && <Text color="error">{error}</Text>}
        <Button key="refresh" label="Refresh" />
      </Box>
    )
  })
}
```

`EngineInterface` is the type of `$` inside a hook (the `Events` map in the types file names it); the test file's `Engine` is the testing kit's, a different type.

- [ ] **Step 6: Run the test to verify it passes**

Run: `claude plugin test plugins/sandbox-tools`
Expected: PASS, 1 test.

- [ ] **Step 7: Validate and type-check**

```bash
claude plugin validate plugins/sandbox-tools
```

Expected: no refusals. Then, since the mod has not loaded in a session yet, the types folder is not laid. Write a throwaway `tsconfig.json` outside the plugin folder per the skill's types-file header, with `include` naming `/private/tmp/claude-503/bundled-skills/2.1.293/8b0b4b58c99e2a411539f3de70d790cc/plugin-authoring/types/claude-code.d.ts` and `plugins/sandbox-tools/hooks`, and run `tsc -p` on it. Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add plugins/sandbox-tools/.claude-plugin/plugin.json plugins/sandbox-tools/hooks plugins/sandbox-tools/types
git commit -m "feat(sandbox-tools): /workspaces pane skeleton

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Fetch and join workspace rows

**Files:**
- Modify: `plugins/sandbox-tools/hooks/register.tsx` (replace `tick`, extend the render)
- Modify: `plugins/sandbox-tools/hooks/register.test.ts` (add fixtures and tests)

**Interfaces:**
- Consumes: `ROWS`, `ERROR`, `SERVER`, `tick($)` from Task 2.
- Produces: `buildRows(list, statuses, sessions): WorkspaceRow[]` and `sessionFor(path, sessions)`, both exported for tests; the row line format `<dot> <name>  <jira>  <running>/<total>  claude: <note>`.

- [ ] **Step 1: Add fixtures and the failing tests**

Append to `register.test.ts`:

```ts
const LIST = {
  root: '/ws',
  workspaces: [
    { name: 'ab', path: '/ws/ab', vscodeUri: 'vscode://file/ws/ab', jiraId: 'PROJ-1', jiraUrl: null, labels: [] },
    { name: 'abc', path: '/ws/abc', vscodeUri: 'vscode://file/ws/abc', jiraId: null, jiraUrl: null, labels: [] },
    { name: 'empty', path: '/ws/empty', vscodeUri: 'vscode://file/ws/empty', jiraId: null, jiraUrl: null, labels: [] },
  ],
}
const STATUS = {
  infra: { state: 'up', running: 1, total: 1, services: [] },
  statuses: [
    { name: 'ab', project: 'sandbox-ab', state: 'up', running: 3, total: 3, slot: 1, ports: null, services: [], claude: { state: 'running', waiting: false } },
    { name: 'abc', project: 'sandbox-abc', state: 'partial', running: 1, total: 3, slot: 2, ports: null, services: [], claude: { state: 'idle', waiting: true } },
    { name: 'empty', project: null, state: 'down', running: 0, total: 0, slot: null, ports: null, services: [], claude: { state: 'idle', waiting: false } },
  ],
}
const SESSIONS = [
  { sessionId: 'local_1', title: 'Newer in abc', cwd: '/ws/abc/repo', link: 'claude://x/local_1', lastActivityAt: '2026-10-09T02:00:00Z' },
  { sessionId: 'local_2', title: 'Older in abc', cwd: '/ws/abc', link: 'claude://x/local_2', lastActivityAt: '2026-10-09T01:00:00Z' },
  { sessionId: 'local_3', title: 'Elsewhere', cwd: '/home/x', link: 'claude://x/local_3', lastActivityAt: '2026-10-09T00:00:00Z' },
]

function stubs(over: Partial<McpStub> = {}): McpStub {
  return {
    'sandbox-workspace/list-workspaces': () => ok(LIST),
    'sandbox-workspace/workspace-status': () => ok(STATUS),
    'ccd_session_mgmt/list_sessions': () => ok(undefined, JSON.stringify(SESSIONS)),
    ...over,
  }
}

test('rows draw dot, jira, counts and claude note', async ($, on) => {
  world(on, stubs())
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect((await ui.find({ key: 'row:ab' }))?.text).toBe('● ab  PROJ-1  3/3  claude: working')
    expect((await ui.find({ key: 'row:abc' }))?.text).toBe('◐ abc  1/3  claude: waiting')
    await ui.unmount()
  }
})

test('no counts when total is 0', async ($, on) => {
  world(on, stubs())
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect((await ui.find({ key: 'row:empty' }))?.text).toBe('○ empty')
    await ui.unmount()
  }
})

test('segment-aware join picks the deepest workspace and the newest session', async ($, on) => {
  world(on, stubs())
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect((await ui.find({ key: 'session:abc' }))?.text).toBe('session: Newer in abc')
    expect(await ui.find({ key: 'session:ab' })).toBeUndefined()
    await ui.unmount()
  }
})

test('sessions from text block with no structuredContent still join', async ($, on) => {
  world(on, stubs({ 'ccd_session_mgmt/list_sessions': () => ({ content: [{ type: 'text', text: JSON.stringify(SESSIONS) }], isError: false }) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect(await ui.find({ key: 'session:abc' })).toBeDefined()
  await ui.unmount()
})

test('a failed session lookup keeps the workspace list', async ($, on) => {
  world(on, stubs({ 'ccd_session_mgmt/list_sessions': () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect(await ui.find({ key: 'row:ab' })).toBeDefined()
  expect(await ui.find({ key: 'session:abc' })).toBeUndefined()
  await ui.unmount()
})

test('a failed list keeps the last rows and shows the error', async ($, on) => {
  let fail = false
  world(on, stubs({ 'sandbox-workspace/list-workspaces': () => (fail ? { content: [{ type: 'text', text: 'docker down' }], isError: true } : ok(LIST)) }))
  await openPane($)
  fail = true
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'row:ab' })).toBeDefined()
  expect((await ui.find({ key: 'error' }))?.text).toBe('docker down')
  await ui.unmount()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test plugins/sandbox-tools`
Expected: the six new tests FAIL (no `row:` keys drawn; `refresh` press changes nothing).

- [ ] **Step 3: Implement `tick`, the join, and the row rendering**

In `register.tsx`, replace the `tick` function and add the helpers above it:

```tsx
type ListResult = { workspaces: { name: string; path: string; jiraId: string | null }[] }
type StatusResult = { statuses: { name: string; state: WorkspaceRow['state']; running: number; total: number; claude: { state: string; waiting: boolean } }[] }
type SessionInfo = { sessionId: string; title: string; cwd: string; link?: string }

/** The tool's structured result, or its first text block parsed as JSON (ccd tools return JSON text). */
function payload<T>(r: { content: { type: string; text?: string }[]; isError: boolean; structuredContent?: unknown }): T {
  if (r.isError) throw new Error(r.content.map(c => c.text ?? '').join(' ').trim() || 'tool failed')
  if (r.structuredContent !== undefined) return r.structuredContent as T
  const text = r.content.find(c => c.type === 'text')?.text ?? ''
  return JSON.parse(text) as T
}

/** True when `child` is `parent` or inside it, by path segment: /ws/ab is not an ancestor of /ws/abc. */
function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}

/** The newest session whose cwd lies in `path`, and in no deeper workspace. Sessions arrive newest first. */
export function sessionFor(path: string, allPaths: string[], sessions: SessionInfo[]): WorkspaceRow['session'] {
  for (const s of sessions) {
    if (!contains(path, s.cwd)) continue
    const deeper = allPaths.some(p => p !== path && p.length > path.length && contains(path, p) && contains(p, s.cwd))
    if (deeper) continue
    return { id: s.sessionId, title: s.title, link: s.link ?? null }
  }
  return null
}

export function buildRows(list: ListResult, status: StatusResult, sessions: SessionInfo[]): WorkspaceRow[] {
  const byName = new Map(status.statuses.map(s => [s.name, s]))
  const allPaths = list.workspaces.map(w => w.path)
  return list.workspaces.map(w => {
    const s = byName.get(w.name)
    return {
      name: w.name,
      path: w.path,
      jiraId: w.jiraId,
      state: s?.state ?? 'unknown',
      running: s?.running ?? 0,
      total: s?.total ?? 0,
      claude: s?.claude.state === 'running' ? 'working' : s?.claude.waiting ? 'waiting' : null,
      session: sessionFor(w.path, allPaths, sessions),
    }
  })
}

const DOT: Record<WorkspaceRow['state'], string> = { up: '●', partial: '◐', stopped: '○', down: '○', unknown: '?' }

export function rowLine(r: WorkspaceRow): string {
  return [DOT[r.state] + ' ' + r.name, r.jiraId, r.total > 0 ? `${r.running}/${r.total}` : null, r.claude ? `claude: ${r.claude}` : null]
    .filter(Boolean)
    .join('  ')
}

let ticking = false

/** Refreshes rows once. A tick that starts while one runs is skipped. */
async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const [listR, statusR, sessionsR] = await Promise.all([
      $.mcp.call(SERVER, 'list-workspaces'),
      $.mcp.call(SERVER, 'workspace-status'),
      $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 50 }).catch(() => null),
    ])
    let sessions: SessionInfo[] = []
    try {
      sessions = sessionsR ? payload<SessionInfo[]>(sessionsR) : []
    } catch {
      sessions = []
    }
    await $.state.set(ROWS, buildRows(payload<ListResult>(listR), payload<StatusResult>(statusR), sessions))
    await $.state.set(ERROR, '')
  } catch (err) {
    await $.state.set(ERROR, (err as Error).message)
  } finally {
    ticking = false
  }
}
```

In the render hook, replace the `rows.length === 0` line and the `error` line with:

```tsx
        {rows.length === 0 && <Text dimColor>No workspaces.</Text>}
        {rows.map(r => (
          <Box key={`ws:${r.name}`} flexDirection="column">
            <Text key={`row:${r.name}`}>{rowLine(r)}</Text>
            {r.session && <Text key={`session:${r.name}`} dimColor>{`session: ${r.session.title}`}</Text>}
          </Box>
        ))}
        {note !== '' && <Text key="note">{note}</Text>}
        {error !== '' && <Text key="error" color="error">{error}</Text>}
```

And add a press hook for refresh, after the `command.run` hook:

```tsx
  on('ui.press', { plugin: PLUGIN, element: 'refresh' }, async ($, e, next) => {
    await tick($)
    return next(e)
  })
```

If `Text` refuses `color="error"` under validation (the transcript line will say so), drop the `color` prop; the key and text are what the tests check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `claude plugin test plugins/sandbox-tools`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/sandbox-tools/hooks
git commit -m "feat(sandbox-tools): workspaces pane lists rows with status and session

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Lifecycle buttons with state gating and busy

**Files:**
- Modify: `plugins/sandbox-tools/hooks/register.tsx`
- Modify: `plugins/sandbox-tools/hooks/register.test.ts`

**Interfaces:**
- Consumes: `BUSY`, `NOTE`, `tick`, `rowLine`, `SERVER`.
- Produces: `buttonsFor(state): Action[]` exported; the `ui.press` hook matched on `{ plugin: PLUGIN }` that parses `e.element` as `<action>:<name>`; `runAction($, name, action)`. Task 5 and 6 add branches inside the same press hook.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
test('buttons follow the extension gating', async ($, on) => {
  world(on, stubs())
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect(await ui.find({ key: 'up:ab' })).toBeUndefined()
    expect(await ui.find({ key: 'stop:ab' })).toBeDefined()
    expect(await ui.find({ key: 'up:abc' })).toBeDefined()
    expect(await ui.find({ key: 'stop:abc' })).toBeDefined()
    expect(await ui.find({ key: 'up:empty' })).toBeDefined()
    expect(await ui.find({ key: 'stop:empty' })).toBeUndefined()
    for (const k of ['restart:ab', 'down:ab', 'switch:ab', 'remove:ab']) expect(await ui.find({ key: k })).toBeDefined()
    await ui.unmount()
  }
})

test('a lifecycle press calls workspace-action and refreshes', async ($, on) => {
  const w = world(on, stubs({ 'sandbox-workspace/workspace-action': a => ok({ command: `sandbox ${a.action}`, output: 'done', path: '/ws/ab' }, `sandbox ${a.action}\n\ndone`) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  const before = w.calls.filter(c => c.key === 'sandbox-workspace/list-workspaces').length
  await ui.press({ key: 'stop:ab' })
  const action = w.calls.find(c => c.key === 'sandbox-workspace/workspace-action')
  expect(action?.args).toEqual({ name: 'ab', action: 'stop' })
  expect(w.calls.filter(c => c.key === 'sandbox-workspace/list-workspaces').length).toBe(before + 1)
  expect((await ui.find({ key: 'note' }))?.text).toBe('sandbox stop')
  await ui.unmount()
})

test('press while busy is ignored', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => { release = r })
  const w = world(on, stubs({ 'sandbox-workspace/workspace-action': () => ok({ command: 'x', output: '', path: '' }) }))
  on('mcp.call', { server: 'sandbox-workspace', tool: 'workspace-action' }, async (_$, e, next) => { await gate; return next(e) })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  const first = ui.press({ key: 'stop:ab' })
  await w.clock.settle()
  expect((await ui.find({ key: 'busy:ab' }))?.text).toBe('working…')
  await ui.press({ key: 'up:abc' })
  release()
  await first
  expect(w.calls.filter(c => c.key === 'sandbox-workspace/workspace-action')).toHaveLength(1)
  await ui.unmount()
})
```

If the kit refuses a second `mcp.call` hook from the test beside `world`'s (a repeat registration on one event throws for a plugin; the test's `on` may allow a matcher), move the gate into `world`'s own `mcp.call` hook by giving `stubs` entries the option to return a Promise and awaiting it there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test plugins/sandbox-tools`
Expected: the three new tests FAIL (no buttons drawn).

- [ ] **Step 3: Implement gating, the press hook, and busy**

Add above `register`:

```tsx
export type Action = 'up' | 'stop' | 'restart' | 'down' | 'switch' | 'remove'
const LIFECYCLE = new Set<Action>(['up', 'stop', 'restart', 'down'])

/** Mirrors the VS Code extension's `view/item/context` when-clauses. */
export function buttonsFor(state: WorkspaceRow['state']): Action[] {
  const out: Action[] = []
  if (state === 'down' || state === 'stopped' || state === 'partial') out.push('up')
  if (state === 'up' || state === 'partial') out.push('stop')
  out.push('restart', 'down', 'switch', 'remove')
  return out
}

const LABEL: Record<Action, string> = { up: 'Up', stop: 'Stop', restart: 'Restart', down: 'Down', switch: 'Switch', remove: 'Remove' }

/** First line of a tool result's text, for the note under the list. */
function firstLine(r: { content: { type: string; text?: string }[] }): string {
  return (r.content.find(c => c.type === 'text')?.text ?? '').split('\n')[0].trim()
}

async function runAction($: EngineInterface, name: string, action: 'up' | 'stop' | 'restart' | 'down' | 'remove'): Promise<void> {
  await $.state.set(BUSY, name)
  await $.state.set(NOTE, `${name}: ${action}…`)
  try {
    const r = action === 'remove'
      ? await $.mcp.call(SERVER, 'remove-workspace', { name })
      : await $.mcp.call(SERVER, 'workspace-action', { name, action })
    await $.state.set(NOTE, firstLine(r) || (r.isError ? 'failed' : 'done'))
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message)
  } finally {
    await $.state.set(BUSY, '')
  }
  await tick($)
}
```

Replace the `refresh` press hook with one hook for every press of this plugin:

```tsx
  on('ui.press', { plugin: PLUGIN }, async ($, e, next) => {
    if (e.element === 'refresh') {
      await tick($)
      return next(e)
    }
    const i = e.element.indexOf(':')
    const action = e.element.slice(0, i) as Action
    const name = e.element.slice(i + 1)
    if (i < 0 || !name) return next(e)

    const { value: busy = '' } = await $.state.get(BUSY)
    if (busy !== '') return next(e)

    if (LIFECYCLE.has(action)) await runAction($, name, action as 'up' | 'stop' | 'restart' | 'down')
    return next(e)
  })
```

In the render hook, read `busy` and draw the buttons under each row. Replace the per-row `Box` with:

```tsx
        {rows.map(r => (
          <Box key={`ws:${r.name}`} flexDirection="column">
            <Text key={`row:${r.name}`}>{rowLine(r)}</Text>
            {busy === r.name ? (
              <Text key={`busy:${r.name}`} dimColor>working…</Text>
            ) : (
              <Box>
                {buttonsFor(r.state).map(a => (
                  <Button key={`${a}:${r.name}`} label={LABEL[a]} />
                ))}
              </Box>
            )}
            {r.session && <Text key={`session:${r.name}`} dimColor>{`session: ${r.session.title}`}</Text>}
          </Box>
        ))}
```

with `const { value: busy = '' } = await $.state.get(BUSY)` added beside the other reads.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `claude plugin test plugins/sandbox-tools`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/sandbox-tools/hooks
git commit -m "feat(sandbox-tools): workspaces pane lifecycle buttons

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Two-press remove

**Files:**
- Modify: `plugins/sandbox-tools/hooks/register.tsx`
- Modify: `plugins/sandbox-tools/hooks/register.test.ts`

**Interfaces:**
- Consumes: `CONFIRM`, `runAction`, the press hook from Task 4.
- Produces: the `remove` branch of the press hook; the button label `Confirm remove` while `confirmRemove` names the row.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
test('remove needs two presses on the same workspace', async ($, on) => {
  const w = world(on, stubs({ 'sandbox-workspace/remove-workspace': () => ok({ command: 'sandbox remove', output: '', path: '/ws/ab' }, 'sandbox remove') }))
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    await ui.press({ key: 'remove:ab' })
    expect(w.calls.filter(c => c.key === 'sandbox-workspace/remove-workspace')).toHaveLength(0)
    expect((await ui.find({ key: 'remove:ab' }))?.props.label).toBe('Confirm remove')
    await ui.press({ key: 'remove:ab' })
    expect(w.calls.filter(c => c.key === 'sandbox-workspace/remove-workspace').map(c => c.args)).toEqual([{ name: 'ab' }])
    expect((await ui.find({ key: 'remove:ab' }))?.props.label).toBe('Remove')
    await ui.unmount()
    w.calls.length = 0
  }
})

test("a press on another row's button clears the pending remove", async ($, on) => {
  const w = world(on, stubs({ 'sandbox-workspace/workspace-action': () => ok({ command: 'sandbox up', output: '', path: '' }, 'sandbox up') }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'remove:ab' })
  await ui.press({ key: 'up:abc' })
  expect((await ui.find({ key: 'remove:ab' }))?.props.label).toBe('Remove')
  await ui.press({ key: 'remove:ab' })
  expect(w.calls.filter(c => c.key === 'sandbox-workspace/remove-workspace')).toHaveLength(0)
  await ui.unmount()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test plugins/sandbox-tools`
Expected: both FAIL (the first press calls nothing and the label stays `Remove`, so the second assertion in test 1 fails; test 2's last assertion holds by accident but the label assertion fails).

- [ ] **Step 3: Implement the confirm step**

In the press hook, after the `busy` check and before the lifecycle branch, add:

```tsx
    const { value: pending = '' } = await $.state.get(CONFIRM)
    if (pending !== '' && pending !== name) await $.state.set(CONFIRM, '')

    if (action === 'remove') {
      if (pending !== name) {
        await $.state.set(CONFIRM, name)
        return next(e)
      }
      await $.state.set(CONFIRM, '')
      await runAction($, name, 'remove')
      return next(e)
    }
```

In the render hook read `const { value: confirm = '' } = await $.state.get(CONFIRM)` and change the button label expression to:

```tsx
                  <Button key={`${a}:${r.name}`} label={a === 'remove' && confirm === r.name ? 'Confirm remove' : LABEL[a]} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `claude plugin test plugins/sandbox-tools`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/sandbox-tools/hooks
git commit -m "feat(sandbox-tools): two-press remove in the workspaces pane

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Switch and the session link

**Files:**
- Modify: `plugins/sandbox-tools/hooks/register.tsx`
- Modify: `plugins/sandbox-tools/hooks/register.test.ts`

**Interfaces:**
- Consumes: the press hook, `NOTE`, rows' `path` and `session`.
- Produces: the `switch` branch; the session entry as a `Link` or as text plus a `jump:<name>` button, per the findings.

Edit these two lines with Task 1's results before starting:

- FINDING 1 (change_directory answers a plugin call): `yes` (the app asks the person to approve the folder, then grants it)
- FINDING 2 (a `claude://` Link focuses the session): `no` (the desktop pane drew nothing for a Link with a claude:// href)

- [ ] **Step 1: Write the failing tests**

Append the Switch test. With FINDING 1 = yes:

```ts
test('switch calls change_directory with the workspace path and toasts', async ($, on) => {
  const w = world(on, stubs({ 'ccd_directory/change_directory': () => ok(undefined, 'Access granted.') }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'switch:abc' })
  expect(w.calls.find(c => c.key === 'ccd_directory/change_directory')?.args).toEqual({ path: '/ws/abc' })
  expect(w.toasts).toEqual(['Switching to abc when this turn ends'])
  await ui.unmount()
})
```

With FINDING 1 = no, this test instead:

```ts
test('switch toasts the command the model should run', async ($, on) => {
  const w = world(on, stubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'switch:abc' })
  expect(w.calls.find(c => c.key === 'ccd_directory/change_directory')).toBeUndefined()
  expect(w.toasts).toEqual(['Type: /workspaces switch abc'])
  await ui.unmount()
})

test('/workspaces switch <name> asks the model to change directory', async ($, on) => {
  world(on, stubs())
  const r = await $.command.run({ command: 'workspaces', args: 'switch abc', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toContain('/ws/abc')
  expect(r.text).toContain('change_directory')
})
```

Append the session entry test. With FINDING 2 = yes:

```ts
test('the session entry is a link to the session', async ($, on) => {
  world(on, stubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  const link = await ui.find({ key: 'session:abc' })
  expect(link?.type).toBe('Link')
  expect(link?.props.href).toBe('claude://x/local_1')
  await ui.unmount()
})
```

With FINDING 2 = no:

```ts
test('jump focuses a session this session started, else toasts its title', async ($, on) => {
  const w = world(on, stubs({ 'ccd_window/open_session_in': () => ({ content: [{ type: 'text', text: 'Only sessions this session started can be focused.' }], isError: true }) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'jump:abc' })
  expect(w.calls.find(c => c.key === 'ccd_window/open_session_in')?.args).toEqual({ session_id: 'local_1', target: 'focus' })
  expect(w.toasts).toEqual(['Open "Newer in abc" from the sidebar'])
  await ui.unmount()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test plugins/sandbox-tools`
Expected: the new tests FAIL (no switch branch; the session entry is a `Text`).

- [ ] **Step 3: Implement Switch**

FINDING 1 = yes. In the press hook, before the lifecycle branch:

```tsx
    if (action === 'switch') {
      const { value: rows = [] } = await $.state.get(ROWS)
      const row = rows.find(r => r.name === name)
      if (!row) return next(e)
      const r = await $.mcp.call('ccd_directory', 'change_directory', { path: row.path })
      if (r.isError) await $.state.set(NOTE, firstLine(r) || 'change_directory refused')
      else $.ui.toast(`Switching to ${name} when this turn ends`)
      return next(e)
    }
```

FINDING 1 = no. The press branch becomes:

```tsx
    if (action === 'switch') {
      $.ui.toast(`Type: /workspaces switch ${name}`)
      return next(e)
    }
```

and the `command.run` hook handles the argument before opening the pane:

```tsx
  on('command.run', { command: 'workspaces' }, async ($, e) => {
    const m = /^switch\s+(\S+)$/.exec(e.args.trim())
    if (m) {
      const { value: rows = [] } = await $.state.get(ROWS)
      const row = rows.find(r => r.name === m[1])
      if (!row) return { text: `No workspace named ${m[1]} in the pane; open /workspaces first.` }
      return { text: `Call the ccd_directory change_directory tool with path ${row.path} to move this session into workspace ${row.name}.` }
    }
    await $.ui.open({ id: PANE, title: 'Sandbox workspaces' })
    await tick($)
    return { text: 'Workspaces pane opened.' }
  })
```

The FINDING 1 = no test calls the command before any pane open, so for it to see `/ws/abc` the switch branch must run `await tick($)` first when `rows` is empty. Add that: `if (rows.length === 0) { await tick($); ... re-read rows }`.

- [ ] **Step 4: Implement the session entry**

FINDING 2 = yes. In the render hook, add `Link` to the destructured table and replace the session line:

```tsx
            {r.session && (r.session.link
              ? <Link key={`session:${r.name}`} href={r.session.link} label={`session: ${r.session.title}`} />
              : <Text key={`session:${r.name}`} dimColor>{`session: ${r.session.title}`}</Text>)}
```

`Link` is absent from the terminal table only if validation says so; the terminal does list `Link`, so no surface branch is needed. If a surface refuses it, branch on `e.surface`.

FINDING 2 = no. Keep the `Text` and add a button beside it:

```tsx
            {r.session && (
              <Box>
                <Text key={`session:${r.name}`} dimColor>{`session: ${r.session.title}`}</Text>
                <Button key={`jump:${r.name}`} label="Jump" />
              </Box>
            )}
```

and in the press hook, before the lifecycle branch:

```tsx
    if (action === 'jump') {
      const { value: rows = [] } = await $.state.get(ROWS)
      const s = rows.find(r => r.name === name)?.session
      if (!s) return next(e)
      const r = await $.mcp.call('ccd_window', 'open_session_in', { session_id: s.id, target: 'focus' })
      if (r.isError) $.ui.toast(`Open "${s.title}" from the sidebar`)
      return next(e)
    }
```

Add `'jump'` to the `Action` union and `LABEL` (`jump: 'Jump'`) but not to `buttonsFor`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `claude plugin test plugins/sandbox-tools`
Expected: PASS, 14 tests (15 with the FINDING 1 = no pair).

- [ ] **Step 6: Commit**

```bash
git add plugins/sandbox-tools/hooks
git commit -m "feat(sandbox-tools): switch and session link in the workspaces pane

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Polling while open

**Files:**
- Modify: `plugins/sandbox-tools/hooks/register.tsx`
- Modify: `plugins/sandbox-tools/hooks/register.test.ts`

**Interfaces:**
- Consumes: `tick`, `POLL_MS`, `PANE`, the `command.run` hook.
- Produces: a module-level `timer` armed on open and re-armed on reload when the pane is already open, cancelled on `ui.close`.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
test('polls every 5 s while open and stops on close', async ($, on) => {
  const w = world(on, stubs())
  await openPane($)
  const count = () => w.calls.filter(c => c.key === 'sandbox-workspace/workspace-status').length
  const n = count()
  await w.clock.advance(5000)
  expect(count()).toBe(n + 1)
  await w.clock.advance(5000)
  expect(count()).toBe(n + 2)
  await $.ui.close({ id: 'workspaces', origin: { kind: 'person' } })
  await w.clock.advance(10000)
  expect(count()).toBe(n + 2)
})

test('unload cancels the timer', async ($, on) => {
  const w = world(on, stubs())
  await openPane($)
  const count = () => w.calls.filter(c => c.key === 'sandbox-workspace/workspace-status').length
  const n = count()
  await $.ui.close({ id: 'workspaces', origin: { kind: 'unload' } })
  await w.clock.advance(10000)
  expect(count()).toBe(n)
})

test('a slow tick is skipped, not queued', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => { release = r })
  let held = 0
  const w = world(on, stubs({ 'sandbox-workspace/workspace-status': () => ok(STATUS) }))
  on('mcp.call', { server: 'sandbox-workspace', tool: 'list-workspaces' }, async (_$, e, next) => { if (held++ === 1) await gate; return next(e) })
  await openPane($)
  await w.clock.advance(5000)
  await w.clock.advance(5000)
  await w.clock.advance(5000)
  release()
  await w.clock.settle()
  expect(w.calls.filter(c => c.key === 'sandbox-workspace/list-workspaces')).toHaveLength(2)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `claude plugin test plugins/sandbox-tools`
Expected: the three FAIL (no timer: counts never rise).

- [ ] **Step 3: Implement the timer**

Add above `register`:

```tsx
let timer: { cancel: () => void } | null = null

function startPolling($: EngineInterface): void {
  timer?.cancel()
  timer = $.clock.every(POLL_MS, () => { void tick($) })
}

function stopPolling(): void {
  timer?.cancel()
  timer = null
}
```

In the `command.run` hook, after `await tick($)`, add `startPolling($)`.

Add a close hook:

```tsx
  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    return next(e)
  })
```

In `session.start`, re-arm after a hot reload left the pane open:

```tsx
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE)) startPolling($)
```

If `$.ui.panes()` returns a shape without `id`, read `UiPaneInfo` (grep `panes: (` in the types) and use its field.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `claude plugin test plugins/sandbox-tools`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/sandbox-tools/hooks
git commit -m "feat(sandbox-tools): poll the workspaces pane while open

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Live check, README, validate

**Files:**
- Modify: `plugins/sandbox-tools/README.md`
- Create (temporary): `/Users/jayboyer/.claude/dev-mods/5a39f4f2-f7af-47c0-8159-a5622386168e/sandbox-tools-pane/` as a copy of the plugin's `.claude-plugin`, `hooks` and `types`

**Interfaces:**
- Consumes: the finished module.
- Produces: the README section and a verified live run.

- [ ] **Step 1: Load the mod live**

Copy the plugin into the hot-reload folder so this session loads it without reinstalling (the installed copy is read from the marketplace clone, not this checkout):

```bash
mkdir -p /Users/jayboyer/.claude/dev-mods/5a39f4f2-f7af-47c0-8159-a5622386168e/sandbox-tools-pane && cp -R plugins/sandbox-tools/.claude-plugin plugins/sandbox-tools/hooks plugins/sandbox-tools/types /Users/jayboyer/.claude/dev-mods/5a39f4f2-f7af-47c0-8159-a5622386168e/sandbox-tools-pane/
```

Edit the copy's `.claude-plugin/plugin.json` `name` to `sandbox-tools-pane` and remove its `mcpServers` line, so it does not start a second MCP server; the installed plugin's server named `sandbox-workspace` is the one `$.mcp.call` reaches. Also change `PLUGIN` in the copy's `register.tsx` and the contract's key to `sandbox-tools-pane`, since `$.state` is held to the contract by name. When the turn ends the mod loads. Type `/workspaces`.

- [ ] **Step 2: Check each control by hand**

- Rows show the workspaces under `~/features` with dots and counts matching `sandbox status`.
- Press Stop on a running workspace; the row shows `working…`, then the note shows `sandbox stop` and the dot changes within 5 s.
- Press Up on it; same, back to `●`.
- Press Remove once: label changes to `Confirm remove`. Press Up on another row: label returns to `Remove`. Do not confirm a remove on a workspace you want to keep.
- Press Switch on a workspace, or run the fallback command; the app asks for the folder or the toast names the command.
- Click the session link, or press Jump.
- Close the pane with its close mark; wait 10 s; `claude --debug`'s log shows no further `workspace-status` calls.

Record anything that differs from the tests as a bug and fix it in the repo copy, re-copy, and re-check.

- [ ] **Step 3: Remove the live copy**

```bash
rm -rf /Users/jayboyer/.claude/dev-mods/5a39f4f2-f7af-47c0-8159-a5622386168e/sandbox-tools-pane
```

- [ ] **Step 4: Write the README section**

In `plugins/sandbox-tools/README.md`, after the "Workspace lifecycle" table and before "### Code standards", add:

```markdown
### Mods

| Mod | What it does |
|-----|--------------|
| `/workspaces` | A docked pane listing every workspace with its container state, the Claude working/waiting flag, and the desktop session open in it. Up / Stop / Restart / Down / Remove run through the bundled `sandbox-workspace` MCP server; Remove asks twice. Switch moves this session into the workspace folder. Source: [`hooks/register.tsx`](hooks/register.tsx). |

Probe findings (2026-10-09): `change_directory` from a plugin call: <yes/no>. `claude://` link in a pane focuses the session: <yes/no>. <One sentence naming the fallback taken, or "No fallback needed.">

To load it from a checkout instead of the marketplace, set `CLAUDE_CODE_PLUGIN_DIRS` to this folder in the `env` block of `~/.claude/settings.json`.
```

Replace the three placeholders with Task 1's findings.

- [ ] **Step 5: Validate, type-check, test**

```bash
claude plugin validate plugins/sandbox-tools && claude plugin test plugins/sandbox-tools
```

Expected: no refusals, all tests pass. Then `tsc -p` on the throwaway tsconfig from Task 2 Step 7 (or `tsc -p plugins/sandbox-tools` if the live load laid `.claude-plugin/types/` there; if it did, add `.claude-plugin/types/` to `plugins/sandbox-tools/.gitignore` so the engine-written folder is not committed).

- [ ] **Step 6: Commit**

```bash
git add plugins/sandbox-tools
git commit -m "docs(sandbox-tools): describe the /workspaces pane mod

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
