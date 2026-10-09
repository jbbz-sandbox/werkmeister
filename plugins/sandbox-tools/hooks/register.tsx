import type { Register, EngineInterface } from 'claude-code'

import type { WorkspaceRow } from '../types'

export const PLUGIN = 'sandbox-tools'
export const PANE = 'workspaces'
export const SERVER = 'sandbox-workspace'
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
        {rows.map(r => (
          <Box key={`ws:${r.name}`} flexDirection="column">
            <Box key={`row:${r.name}`}><Text>{rowLine(r)}</Text></Box>
            {r.session && <Box key={`session:${r.name}`}><Text dimColor>{`session: ${r.session.title}`}</Text></Box>}
          </Box>
        ))}
        {note !== '' && <Box key="note"><Text>{note}</Text></Box>}
        {error !== '' && <Box key="error"><Text color="error">{error}</Text></Box>}
        <Button key="refresh" label="Refresh" onPress={() => void tick($)} />
      </Box>
    )
  })
}
