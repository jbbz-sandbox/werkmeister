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
import { realpathSync, readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
  const yaml = createRequire(file)('yaml')
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
  // The first ICM stage whose output/ is still empty; null when no stages/ dir or every stage has output.
  const stageOf = dir => {
    let names
    try { names = readdirSync(join(dir, 'stages')).filter(n => /^\\d+_/.test(n)).sort() } catch { return null }
    for (let i = 0; i < names.length; i++) {
      let files = []
      try { files = readdirSync(join(dir, 'stages', names[i], 'output')).filter(f => !f.startsWith('.')) } catch { /* no output dir yet */ }
      if (files.length === 0) return { index: i + 1, total: names.length, name: names[i].replace(/^\\d+_/, '') }
    }
    return null
  }
  // The transcript's "entrypoint" field (claude-vscode, claude-desktop, sdk-cli, ...) from its first 64 KiB; null when unknown.
  const originOf = (dir, sessionId) => {
    const enc = p => p.replace(/[^a-zA-Z0-9]/g, '-')
    const root = join(homedir(), '.claude', 'projects')
    let fd = null
    try {
      const proj = readdirSync(root).find(n => enc(n) === enc(dir))
      if (!proj) return null
      fd = openSync(join(root, proj, sessionId + '.jsonl'), 'r')
      const buf = Buffer.alloc(65536)
      const head = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0))
      return head.match(/"entrypoint":"([^"]+)"/)?.[1] ?? null
    } catch { return null } finally { if (fd !== null) closeSync(fd) }
  }
  const details = async w => {
    let cfg = {}
    try { cfg = yaml.parse(readFileSync(join(w.path, '.sandbox', 'workspace.yml'), 'utf8')) ?? {} } catch { /* not initialised */ }
    let newest = null
    try { newest = (await core.listSessions(w.name))[0] ?? null } catch { /* no sessions */ }
    const sessionOrigin = newest ? originOf(w.path, newest.sessionId) : null
    return { ...w, task: str(cfg.task), description: str(cfg.description), workType: str(cfg.work_type), stage: stageOf(w.path), sessionTitle: newest?.title ?? null, sessionOrigin }
  }
  const ops = {
    'list-workspaces': async () => { const r = await core.listWorkspaces(); return { ...r, workspaces: await Promise.all(r.workspaces.map(details)) } },
    'workspace-status': () => core.getWorkspaceStatuses(),
    'workspace-action': () => core.runWorkspaceAction(args.name, args.action),
    'remove-workspace': () => core.removeWorkspace(args.name),
    'claude-resume': () => core.resumeClaudeInTerminal(args.name),
    'open-vscode': () => { execFileSync('open', ['-a', 'Visual Studio Code', args.path]); return { path: args.path } },
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

type ListEntry = Pick<WorkspaceRow, 'name' | 'path' | 'jiraId' | 'task' | 'description' | 'workType' | 'stage' | 'sessionTitle' | 'sessionOrigin'>
type ListResult = { workspaces: ListEntry[] }
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
      ...w,
      state: s?.state ?? 'unknown',
      running: s?.running ?? 0,
      total: s?.total ?? 0,
      claude: s?.claude.state === 'running' ? 'working' : s?.claude.waiting ? 'waiting' : null,
      session: sessionFor(w.path, allPaths, sessions),
    }
  })
}

/** The card border carries the state; nothing else in the card repeats it. */
const BORDER: Record<WorkspaceRow['state'], 'success' | 'warning' | 'inactive'> = { up: 'success', partial: 'warning', stopped: 'inactive', down: 'inactive', unknown: 'warning' }

/** The card's detail line: work type, ICM stage, running/total; '' when none. */
export function cardMeta(r: WorkspaceRow): string {
  return [
    r.workType,
    r.stage ? `stage ${r.stage.index}/${r.stage.total} ${r.stage.name}` : null,
    r.total > 0 ? `${r.running}/${r.total}` : null,
  ].filter(Boolean).join(' · ')
}

/** The Claude flag at the header's right edge: waiting on you is the one thing a glance must catch. */
const CLAUDE: Record<NonNullable<WorkspaceRow['claude']>, { text: string; color: 'warning' | 'claude' }> = {
  waiting: { text: '● waiting for you', color: 'warning' },
  working: { text: '◌ working', color: 'claude' },
}

/** The session line's title: the desktop session in the folder, else the newest on-disk session. */
export function sessionTitle(r: WorkspaceRow): string | null {
  return r.session?.title ?? r.sessionTitle
}

/** Where the session shown lives, so Jump's target is known before the press: Desktop, VS Code, or CLI. */
export function sessionOrigin(r: WorkspaceRow): 'Desktop' | 'VS Code' | 'CLI' | null {
  if (r.session) return 'Desktop'
  if (r.sessionOrigin === null) return null
  return r.sessionOrigin === 'claude-vscode' ? 'VS Code' : r.sessionOrigin === 'claude-desktop' ? 'Desktop' : 'CLI'
}

/** The session line: `session · VS Code · title`. */
export function sessionLine(r: WorkspaceRow): string | null {
  const title = sessionTitle(r)
  return title ? ['session', sessionOrigin(r), title].filter(Boolean).join(' · ') : null
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

const LABEL: Record<Action, string> = { up: '▶ Up', stop: '■ Stop', restart: '↻ Restart', down: '⏻ Down', switch: '⇥ Switch', remove: '✕ Remove', jump: '↗ Jump' }

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
    const row = rows.find(r => r.name === name)
    if (!row) return
    if (row.session) {
      const r = await $.mcp.call('ccd_window', 'open_session_in', { session_id: row.session.id, target: 'focus' })
      if (r.isError) $.ui.toast(`Open "${row.session.title}" from the sidebar`)
      return
    }
    try {
      if (row.sessionOrigin === 'claude-vscode') {
        await core($, 'open-vscode', { path: row.path })
        $.ui.toast(`Opening ${name} in VS Code`)
        return
      }
      await core($, 'claude-resume', { name })
      $.ui.toast(`Resuming "${row.sessionTitle ?? name}" in a Terminal window`)
    } catch (err) {
      await $.state.set(NOTE, (err as Error).message)
    }
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

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Sandbox workspaces' })
  await tick($)
  startPolling($)
}

/** A folder of workspaces (e.g. ~/features): some direct child holds `.sandbox/workspace.yml`. */
async function holdsWorkspaces($: EngineInterface, dir: string): Promise<boolean> {
  const entries = await $.fs.list(dir).catch(() => [])
  for (const d of entries) {
    if (d.kind === 'dir' && (await $.fs.exists(`${dir}/${d.name}/.sandbox/workspace.yml`))) return true
  }
  return false
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'workspaces', description: 'Open the sandbox workspaces pane' })
    // A hot reload drops the old environment's timer but leaves the pane open: re-arm it.
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE)) startPolling($)
    else if (e.isInteractive && (await holdsWorkspaces($, e.cwd))) await openPane($)
    return next(e)
  })

  on('command.run', { command: 'workspaces' }, async $ => {
    await openPane($)
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
    // The workspace this session already sits in gets no Switch.
    const here = await $.session.cwd().catch(() => '')

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No workspaces.</Text>}
        {rows.map(r => (
          <Box key={`ws:${r.name}`} flexDirection="column" borderStyle="round" borderColor={BORDER[r.state]} borderDimColor={BORDER[r.state] === 'inactive' ? true : undefined} paddingX={1} marginBottom={1}>
            <Box key={`head:${r.name}`} justifyContent="space-between">
              <Box key={`row:${r.name}`}>
                <Text bold>{r.name}</Text>
                {r.jiraId && <Text dimColor>{` · ${r.jiraId}`}</Text>}
              </Box>
              {r.claude && <Box key={`claude:${r.name}`}><Text color={CLAUDE[r.claude].color}>{CLAUDE[r.claude].text}</Text></Box>}
            </Box>
            {r.task && <Box key={`task:${r.name}`}><Text>{r.task}</Text></Box>}
            {r.description && <Box key={`desc:${r.name}`}><Text dimColor>{r.description}</Text></Box>}
            {cardMeta(r) !== '' && <Box key={`meta:${r.name}`}><Text dimColor>{cardMeta(r)}</Text></Box>}
            {sessionLine(r) && <Box key={`session:${r.name}`}><Text dimColor>{sessionLine(r)}</Text></Box>}
            {busy === r.name ? (
              <Box key={`busy:${r.name}`}><Text dimColor>working…</Text></Box>
            ) : (
              <Box marginTop={1} justifyContent="space-between">
                <Box gap={1}>
                  {buttonsFor(r.state).filter(a => a !== 'remove' && a !== 'switch').map(a => (
                    <Button key={`${a}:${r.name}`} label={LABEL[a]} variant="secondary" onPress={() => void press($, a, r.name)} />
                  ))}
                  <Box marginLeft={2} gap={1}>
                    {!(here && contains(r.path, here)) && <Button key={`switch:${r.name}`} label={LABEL.switch} variant="secondary" onPress={() => void press($, 'switch', r.name)} />}
                    {sessionTitle(r) && <Button key={`jump:${r.name}`} label={LABEL.jump} variant="secondary" onPress={() => void press($, 'jump', r.name)} />}
                  </Box>
                </Box>
                {/* Buttons take no colour; the label turns red under the pointer and the confirm prompt is red text beside it. */}
                <Box gap={1}>
                  {confirm === r.name && <Box key={`danger:${r.name}`}><Text color="error">{'Delete this workspace?'}</Text></Box>}
                  <Button key={`remove:${r.name}`} label={confirm === r.name ? '✕ Yes, remove' : LABEL.remove} variant="secondary" dimColor hover={{ color: 'error', dimColor: false }} onPress={() => void press($, 'remove', r.name)} />
                </Box>
              </Box>
            )}
          </Box>
        ))}
        {note !== '' && <Box key="note"><Text>{note}</Text></Box>}
        {error !== '' && <Box key="error"><Text color="error">{error}</Text></Box>}
      </Box>
    )
  })
}
