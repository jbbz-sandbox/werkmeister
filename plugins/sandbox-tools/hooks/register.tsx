import type { Register, EngineInterface } from 'claude-code'

import type { WorkspaceRow } from '../types'

export const PLUGIN = 'sandbox-tools'
export const PANE = 'workspaces'

// Workspace reads and actions run sandbox-core in a node child, the way the former /workspace-form mod did:
// the plugin's own MCP server is not answerable from a hook in the desktop host, a host process is.
// stdin carries one JSON request { op, ...args }; stdout ends with one JSON line { ok, result | error }.
// sandbox-core is found from $SANDBOX_CORE_PATH, else from where the `sandbox` binary resolves its dependencies.
const SCRIPT = `
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
const out = o => console.log(JSON.stringify(o))
try {
  let s = ''
  for await (const c of process.stdin) s += c
  const { op, ...args } = JSON.parse(s)
  let file = process.env.SANDBOX_CORE_PATH
  if (!file) {
    const bin = realpathSync(execFileSync('sh', ['-c', 'command -v sandbox']).toString().trim())
    file = createRequire(dirname(bin) + '/x').resolve('sandbox-core')
  }
  const core = await import(pathToFileURL(file).href)
  const ops = {
    'list-workspaces': () => core.listWorkspaces(),
    'workspace-status': () => core.getWorkspaceStatuses(),
    'workspace-action': () => core.runWorkspaceAction(args.name, args.action),
    'remove-workspace': () => core.removeWorkspace(args.name),
  }
  if (!ops[op]) throw new Error('unknown op ' + op)
  out({ ok: true, result: await ops[op]() })
} catch (e) {
  out({ ok: false, error: (e && e.message) || String(e) })
}
`

/** One sandbox-core call in a node child; throws with the child's error text. */
async function core<T>($: EngineInterface, op: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
  const r = await $.process.run(['node', '--input-type=module', '-e', SCRIPT], { stdin: JSON.stringify({ op, ...args }), timeoutMs })
  const line = r.stdout.trim().split('\n').pop() ?? ''
  let o: { ok: boolean; result?: T; error?: string }
  try {
    o = JSON.parse(line)
  } catch {
    throw new Error(r.stderr.trim().split('\n').pop() || `sandbox-core gave no result (exit ${r.exitCode})`)
  }
  if (!o.ok || o.result === undefined) throw new Error(o.error ?? 'sandbox-core failed')
  return o.result
}
export const POLL_MS = 5000

const ROWS = { plugin: 'sandbox-tools', key: 'rows' } as const
const ERROR = { plugin: 'sandbox-tools', key: 'error' } as const
const BUSY = { plugin: 'sandbox-tools', key: 'busy' } as const
const CONFIRM = { plugin: 'sandbox-tools', key: 'confirmRemove' } as const
const NOTE = { plugin: 'sandbox-tools', key: 'note' } as const

type ListResult = { workspaces: { name: string; path: string; jiraId: string | null }[] }
type StatusResult = { statuses: { name: string; state: WorkspaceRow['state']; running: number; total: number; claude: { state: string; waiting: boolean } }[] }
type SessionInfo = { sessionId: string; title: string; cwd: string; link?: string }
type ToolResult = { content: { type: string; text?: string }[]; isError: boolean; structuredContent?: unknown }

/** The tool's structured result, or its first text block parsed as JSON (ccd tools return JSON text). */
function payload<T>(r: ToolResult): T {
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
    const [list, status, sessionsR] = await Promise.all([
      core<ListResult>($, 'list-workspaces'),
      core<StatusResult>($, 'workspace-status'),
      $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 50 }).catch(() => null),
    ])
    let sessions: SessionInfo[] = []
    try {
      sessions = sessionsR ? payload<SessionInfo[]>(sessionsR) : []
    } catch {
      sessions = []
    }
    await $.state.set(ROWS, buildRows(list, status, sessions))
    await $.state.set(ERROR, '')
  } catch (err) {
    await $.state.set(ERROR, (err as Error).message)
  } finally {
    ticking = false
  }
}

export type Action = 'up' | 'stop' | 'restart' | 'down' | 'switch' | 'remove' | 'jump'
type Lifecycle = 'up' | 'stop' | 'restart' | 'down'
const LIFECYCLE = new Set<Action>(['up', 'stop', 'restart', 'down'])

/** Mirrors the VS Code extension's `view/item/context` when-clauses. */
export function buttonsFor(state: WorkspaceRow['state']): Action[] {
  const out: Action[] = []
  if (state === 'down' || state === 'stopped' || state === 'partial') out.push('up')
  if (state === 'up' || state === 'partial') out.push('stop')
  out.push('restart', 'down', 'switch', 'remove')
  return out
}

const LABEL: Record<Action, string> = { up: 'Up', stop: 'Stop', restart: 'Restart', down: 'Down', switch: 'Switch', remove: 'Remove', jump: 'Jump' }

/** First line of a tool result's text, for the note under the list. */
function firstLine(r: ToolResult): string {
  return (r.content.find(c => c.type === 'text')?.text ?? '').split('\n')[0]?.trim() ?? ''
}

async function runAction($: EngineInterface, name: string, action: Lifecycle | 'remove'): Promise<void> {
  await $.state.set(BUSY, name)
  await $.state.set(NOTE, `${name}: ${action}…`)
  try {
    const r = action === 'remove'
      ? await core<{ command: string; output: string }>($, 'remove-workspace', { name }, 600000)
      : await core<{ command: string; output: string }>($, 'workspace-action', { name, action }, 600000)
    await $.state.set(NOTE, r.command.split('\n')[0]?.trim() || 'done')
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message)
  } finally {
    await $.state.set(BUSY, '')
  }
  await tick($)
}

/** Every row button lands here. A press while any action runs is ignored, never queued. */
async function press($: EngineInterface, action: Action, name: string): Promise<void> {
  const { value: busy = '' } = await $.state.get(BUSY)
  if (busy !== '') return

  const { value: pending = '' } = await $.state.get(CONFIRM)
  if (pending !== '' && pending !== name) await $.state.set(CONFIRM, '')

  if (action === 'switch') {
    const { value: rows = [] } = await $.state.get(ROWS)
    const row = rows.find(r => r.name === name)
    if (!row) return
    const r = await $.mcp.call('ccd_directory', 'change_directory', { path: row.path })
    if (r.isError) await $.state.set(NOTE, firstLine(r) || 'change_directory refused')
    else $.ui.toast(`Switching to ${name} when this turn ends`)
    return
  }

  // A claude:// Link draws nothing on the desktop pane (probe, 2026-10-09), so a button asks the app to focus the session instead.
  if (action === 'jump') {
    const { value: rows = [] } = await $.state.get(ROWS)
    const session = rows.find(r => r.name === name)?.session
    if (!session) return
    const r = await $.mcp.call('ccd_window', 'open_session_in', { session_id: session.id, target: 'focus' })
    if (r.isError) $.ui.toast(`Open "${session.title}" from the sidebar`)
    return
  }

  if (action === 'remove') {
    if (pending !== name) {
      await $.state.set(CONFIRM, name)
      return
    }
    await $.state.set(CONFIRM, '')
    await runAction($, name, 'remove')
    return
  }

  if (LIFECYCLE.has(action)) await runAction($, name, action as Lifecycle)
}

let timer: { cancel: () => void } | null = null

function startPolling($: EngineInterface): void {
  timer?.cancel()
  timer = $.clock.every(POLL_MS, () => {
    void tick($)
  })
}

function stopPolling(): void {
  timer?.cancel()
  timer = null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'workspaces', description: 'Open the sandbox workspaces pane' })
    // A hot reload drops the old environment's timer but leaves the pane open: re-arm it.
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE)) startPolling($)
    return next(e)
  })

  on('command.run', { command: 'workspaces' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sandbox workspaces' })
    await tick($)
    startPolling($)
    return { text: 'Workspaces pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: rows = [] } = await $.state.get(ROWS)
    const { value: error = '' } = await $.state.get(ERROR)
    const { value: note = '' } = await $.state.get(NOTE)
    const { value: busy = '' } = await $.state.get(BUSY)
    const { value: confirm = '' } = await $.state.get(CONFIRM)

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No workspaces.</Text>}
        {rows.map(r => (
          <Box key={`ws:${r.name}`} flexDirection="column">
            <Box key={`row:${r.name}`}><Text>{rowLine(r)}</Text></Box>
            {busy === r.name ? (
              <Box key={`busy:${r.name}`}><Text dimColor>working…</Text></Box>
            ) : (
              <Box>
                {buttonsFor(r.state).map(a => (
                  <Button key={`${a}:${r.name}`} label={a === 'remove' && confirm === r.name ? 'Confirm remove' : LABEL[a]} onPress={() => void press($, a, r.name)} />
                ))}
              </Box>
            )}
            {r.session && (
              <Box>
                <Box key={`session:${r.name}`}><Text dimColor>{`session: ${r.session.title}`}</Text></Box>
                <Button key={`jump:${r.name}`} label={LABEL.jump} onPress={() => void press($, 'jump', r.name)} />
              </Box>
            )}
          </Box>
        ))}
        {note !== '' && <Box key="note"><Text>{note}</Text></Box>}
        {error !== '' && <Box key="error"><Text color="error">{error}</Text></Box>}
        <Button key="refresh" label="Refresh" onPress={() => void tick($)} />
      </Box>
    )
  })
}
