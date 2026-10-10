import type { Register, EngineInterface } from 'claude-code'

import type { Draft, FormBundle, FormField, WorkspaceRow } from '../types'

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
    'form-schema': async () => {
      const tracker = await import(pathToFileURL(join(dirname(file), 'issue_tracker.js')).href)
      return { bundle: await core.getFormSchema(), trackerLabel: tracker.issueTracker().label }
    },
    'issue-form-data': () => core.fetchIssueFormData(args.ref),
    'create-workspace': () => core.createWorkspace(args.formData),
    'refine-prompt': () => core.refinePrompt(args.text, args.instruction, args.formData),
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
const TAB = { plugin: 'sandbox-tools', key: 'tab' } as const

const FORM = { plugin: 'sandbox-tools', key: 'formSchema' } as const
const DRAFT = { plugin: 'sandbox-tools', key: 'draft' } as const
const FORM_BUSY = { plugin: 'sandbox-tools', key: 'formBusy' } as const
const FOCUSED = { plugin: 'sandbox-tools', key: 'focusedField' } as const

/** Mobile draws no Input or Select, so there the Create tab hands the form to the model instead. */
export function createPrompt(issueId: string): string {
  const id = issueId.trim()
  return `Create a new sandbox workspace with the sandbox-workspace skill${id ? `, pre-filled from issue ${id}` : ''}.`
}

/**
 * The create form's fields from the same RJSF bundle the browser form renders
 * (getFormSchema: the terminal wizard's prompts), in its `ui:order`. An array
 * with choices is a multi-pick; a string with choices a select; a `textarea`
 * widget a multi-line field; the rest one line. Titles lose the wizard's
 * terminal hints, `(blank to skip)` and the like: the form marks required
 * fields itself and the description says the rest.
 */
export function formFields(bundle: FormBundle): FormField[] {
  const props = bundle.schema.properties ?? {}
  const order = (bundle.uiSchema['ui:order'] as string[] | undefined) ?? Object.keys(props)
  const required = new Set(bundle.schema.required ?? [])
  return order.flatMap(k => {
    const p = props[k]
    if (!p) return []
    const ui = (bundle.uiSchema[k] ?? {}) as Record<string, unknown>
    const options = (p.type === 'array' ? p.items?.enum : p.enum) ?? []
    return {
      key: k,
      title: (p.title ?? k).replace(/\s*\([^)]*\)\s*$/, ''),
      help: p.description ?? '',
      kind: options.length ? (p.type === 'array' ? 'multi' : 'select') : ui['ui:widget'] === 'textarea' ? 'textarea' : 'text',
      options,
      groups: (((ui['ui:options'] ?? {}) as { groups?: Record<string, string[]> }).groups) ?? {},
      refine: refineOf(ui),
      required: required.has(k),
      pattern: p.pattern ?? null,
      placeholder: typeof ui['ui:placeholder'] === 'string' ? ui['ui:placeholder'] : '',
    } satisfies FormField
  })
}

/** A refinable field's instruction for refinePrompt ("" = its default), or null when the field isn't refinable. */
function refineOf(ui: Record<string, unknown>): string | null {
  const o = (ui['ui:options'] ?? {}) as { refinable?: boolean; refineInstruction?: string }
  return o.refinable ? (o.refineInstruction ?? '') : null
}

/** A multi-pick draws as checkboxes in this many columns, as the browser form does. */
const COLUMNS = 5

/** [heading, options] in schema order: the bundle's groups (an option in none goes under "other"), else one unheaded group. */
export function optionGroups(f: FormField): [string, string[]][] {
  const headings = Object.keys(f.groups)
  if (!headings.length) return [['', f.options]]
  const grouped = new Set(Object.values(f.groups).flat())
  const out: [string, string[]][] = headings.sort().map(h => [h, f.options.filter(o => f.groups[h]!.includes(o))])
  const rest = f.options.filter(o => !grouped.has(o))
  if (rest.length) out.push(['other', rest])
  return out.filter(([, opts]) => opts.length > 0)
}


const isEmpty = (v: Draft[string] | undefined) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** An issue's fields fill only what the person left empty; the issue ID itself is the lookup's normalised one. */
export function mergeIssueFields(draft: Draft, data: Record<string, unknown>): Draft {
  const out = { ...draft }
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string' && !Array.isArray(v)) continue
    if (k === 'issue_id' || isEmpty(out[k])) out[k] = Array.isArray(v) ? v.map(String) : v
  }
  return out
}

/** Why the draft can't be submitted, one line per field; [] when it can. */
export function formErrors(fields: FormField[], draft: Draft): string[] {
  const out: string[] = []
  for (const f of fields) {
    const v = draft[f.key]
    if (isEmpty(v)) {
      if (f.required) out.push(`${f.title}: required`)
    } else if (f.pattern && typeof v === 'string' && !new RegExp(f.pattern).test(v)) {
      out.push(`${f.title}: "${v}" doesn't match the expected format`)
    }
  }
  return out
}

/**
 * Values from the workspace_form tool laid over the draft: a key the form doesn't
 * have, a choice it doesn't offer or a value of the wrong shape is left out and
 * named in `problems`. "" or [] clears a field; a multi-pick also takes "a, b".
 */
export function applyFormFields(fields: FormField[], draft: Draft, input: Record<string, unknown>): { draft: Draft; problems: string[] } {
  const out = { ...draft }
  const problems: string[] = []
  for (const [k, raw] of Object.entries(input)) {
    const f = fields.find(x => x.key === k)
    if (!f) {
      problems.push(`${k}: no such field (fields: ${fields.map(x => x.key).join(', ')})`)
      continue
    }
    if (f.kind === 'multi') {
      const list = typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw
      if (!Array.isArray(list) || !list.every(v => typeof v === 'string')) {
        problems.push(`${k}: expected a list of choices`)
        continue
      }
      const bad = list.filter(v => !f.options.includes(v))
      if (bad.length) problems.push(`${k}: not offered: ${bad.join(', ')} (choices: ${f.options.join(', ')})`)
      out[k] = list.filter(v => f.options.includes(v))
      continue
    }
    if (typeof raw !== 'string') {
      problems.push(`${k}: expected text`)
      continue
    }
    if (f.kind === 'select' && raw !== '' && !f.options.includes(raw)) {
      problems.push(`${k}: "${raw}" is not offered (choices: ${f.options.join(', ')})`)
      continue
    }
    out[k] = raw
  }
  return { draft: out, problems }
}

const FORM_TOOL = 'workspace_form'

/** The workspace_form tool: fill the Create tab from the prompt, then the person reviews and creates. */
async function fillFormTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  await openPane($)
  await openCreate($)
  const { value: form = null } = await $.state.get(FORM)
  if (!form) {
    const { value: note = '' } = await $.state.get(NOTE)
    return note || "Couldn't load the workspace form."
  }
  const fields = formFields(form.bundle)
  const { value: draft = {} } = await $.state.get(DRAFT)
  const given = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields) ? (input.fields as Record<string, unknown>) : {}
  const r = applyFormFields(fields, draft, given)
  await $.state.set(DRAFT, r.draft)
  const missing = formErrors(fields, r.draft)
  return [
    `The Create tab of the /workspaces pane now holds:`,
    JSON.stringify(r.draft, null, 2),
    r.problems.length ? `Left out:\n- ${r.problems.join('\n- ')}` : '',
    missing.length ? `Still needed before Create:\n- ${missing.join('\n- ')}` : 'Ready: the person presses ＋ Create workspace in the pane to create it.',
    'This tool never creates the workspace.',
  ].filter(Boolean).join('\n\n')
}

async function openCreate($: EngineInterface): Promise<void> {
  await $.state.set(TAB, 'create')
  const { value: form = null } = await $.state.get(FORM)
  if (form) return
  try {
    const r = await core<{ bundle: FormBundle; trackerLabel: string }>($, 'form-schema')
    await $.state.set(FORM, { bundle: r.bundle, trackerLabel: r.trackerLabel })
    await $.state.set(DRAFT, r.bundle.formData ?? {})
  } catch (err) {
    await $.state.set(NOTE, `Couldn't load the workspace form: ${(err as Error).message}`)
  }
}

async function setField($: EngineInterface, key: string, value: string | string[]): Promise<void> {
  const { value: draft = {} } = await $.state.get(DRAFT)
  await $.state.set(DRAFT, { ...draft, [key]: value })
}

async function fetchIssue($: EngineInterface): Promise<void> {
  const { value: draft = {} } = await $.state.get(DRAFT)
  const ref = typeof draft.issue_id === 'string' ? draft.issue_id.trim() : ''
  if (!ref) return
  await $.state.set(FORM_BUSY, 'fetch')
  try {
    const data = await core<Record<string, unknown>>($, 'issue-form-data', { ref }, 180000)
    if (!data.issue_id) {
      await $.state.set(NOTE, `Couldn't read an issue from "${ref}".`)
      return
    }
    const { value: now = {} } = await $.state.get(DRAFT)
    const merged = mergeIssueFields(now, data)
    const filled = Object.keys(data).filter(k => k !== 'issue_id' && isEmpty(now[k]) && !isEmpty(merged[k]))
    await $.state.set(DRAFT, merged)
    await $.state.set(NOTE, filled.length ? `Filled ${filled.join(', ')} from ${data.issue_id}.` : `${data.issue_id}: nothing new to fill.`)
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message)
  } finally {
    await $.state.set(FORM_BUSY, '')
  }
}

/** "Refine with Claude": rewrite the field with refinePrompt, the issue and the other fields as context. */
async function refineField($: EngineInterface, key: string, instruction: string): Promise<void> {
  const { value: draft = {} } = await $.state.get(DRAFT)
  const text = typeof draft[key] === 'string' ? draft[key].trim() : ''
  if (!text) {
    await $.state.set(NOTE, 'Write something first; Refine rewrites what is there.')
    return
  }
  await $.state.set(FORM_BUSY, 'refine')
  try {
    const formData = Object.fromEntries(Object.entries(draft).filter(([, v]) => !isEmpty(v)))
    const refined = (await core<string>($, 'refine-prompt', { text, instruction, formData }, 180000)).trim()
    if (!refined) {
      await $.state.set(NOTE, 'Refine returned no text; the field is unchanged.')
      return
    }
    await setField($, key, refined)
    await $.state.set(NOTE, 'Refined. Edit it, or Refine again.')
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message)
  } finally {
    await $.state.set(FORM_BUSY, '')
  }
}

async function submitForm($: EngineInterface): Promise<void> {
  const { value: form = null } = await $.state.get(FORM)
  const { value: draft = {} } = await $.state.get(DRAFT)
  if (!form) return
  const errors = formErrors(formFields(form.bundle), draft)
  if (errors.length) {
    await $.state.set(NOTE, errors.join('\n'))
    return
  }
  const formData = Object.fromEntries(Object.entries(draft).filter(([, v]) => !isEmpty(v)))
  await $.state.set(FORM_BUSY, 'create')
  await $.state.set(NOTE, 'Creating the workspace…')
  try {
    const r = await core<{ command: string; workspacePath: string | null }>($, 'create-workspace', { formData }, 600000)
    await $.state.set(DRAFT, {})
    await $.state.set(TAB, 'list')
    await $.state.set(NOTE, `Created ${r.workspacePath ?? r.command}`)
    $.ui.toast('Workspace created')
  } catch (err) {
    // The transcript can run long; its last lines carry the failure.
    await $.state.set(NOTE, (err as Error).message.split('\n').slice(-6).join('\n'))
  } finally {
    await $.state.set(FORM_BUSY, '')
  }
  await tick($)
}

type ListEntry = Pick<WorkspaceRow, 'name' | 'path' | 'issueId' | 'task' | 'description' | 'workType' | 'stage' | 'sessionTitle' | 'sessionOrigin'>
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
    if (r.isError) {
      await $.state.set(NOTE, firstLine(r) || 'change_directory refused')
      return
    }
    // change_directory moves the cwd only when a turn ends, and a press on an idle session starts none: submit one.
    $.ui.toast(`Switching to ${name}`)
    void $.prompt.submit({ text: `Switched to workspace ${name}. Read ${row.path}/CLAUDE.md, then wait for my next instruction.` })
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
    await $.tool.register({
      name: FORM_TOOL,
      description:
        "Fill fields of the New Sandbox Workspace form in the /workspaces pane's Create tab, so the person can " +
        'set them from the prompt (e.g. paste a long starting prompt) and review before creating. Opens the pane on ' +
        'the Create tab. Each value replaces the field; "" clears it. Fields: issue_id, feature (lowercase-hyphen ' +
        'slug), work_type, context_strategy, services and repos (lists of choices), labels, test_path, task, ' +
        'description, starting_prompt (multi-line). Pass {} as fields to read the current values. Returns what the ' +
        'form holds, values it left out and why, and what is still required. It never creates the workspace: the ' +
        'person presses Create in the pane.',
      inputSchema: {
        type: 'object',
        properties: {
          fields: {
            type: 'object',
            description: 'Field key → value: a string, or a list of strings for services and repos.',
            additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          },
        },
        required: ['fields'],
      },
      isDeferred: false,
    })
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

  // A regex: the tool-name type only lists tools laid when the types were written, and this one registers at start.
  // The call's input fields arrive on the event itself, beside `tool` and `tool_use_id`.
  on('tool.call', { tool: /^mcp__sandbox-tools__workspace_form$/ }, async ($, e) => ({ result: await fillFormTool($, e as unknown as Record<string, unknown>) })).catch(
    () => ({ deny: 'The workspace form could not be filled; open /workspaces and fill it by hand.' }),
  )

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    return next(e)
  })

  // The multi-line fields (textarea.tsx) post every edit as { value }; the element is `f:<field key>`.
  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    if (!e.element.startsWith('f:')) return next(e)
    const key = e.element.slice(2)
    const data = (e.data ?? {}) as { value?: unknown; focus?: unknown; submit?: unknown }
    if (data.focus === true) await $.state.set(FOCUSED, key)
    if (typeof data.value === 'string') await setField($, key, data.value)
    // Enter in the issue field fills from the issue; elsewhere a one-line Enter does nothing.
    if (data.submit === true && key === 'issue_id') void fetchIssue($)
    return {}
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
    const { value: tab = 'list' } = await $.state.get(TAB)
    // Mobile draws no Input or Select; there the Create tab hands the form to the model.
    const els = $.ui.resolve(e)
    const Input = 'Input' in els ? els.Input : null
    const Select = 'Select' in els ? els.Select : null

    const tabs = (
      <Box key="tabs" gap={1} marginBottom={1}>
        <Button key="tab:list" label="Workspaces" variant={tab === 'list' ? 'primary' : 'secondary'} onPress={() => void $.state.set(TAB, 'list')} />
        <Button key="tab:create" label="＋ Create" variant={tab === 'create' ? 'primary' : 'secondary'} onPress={() => void openCreate($)} />
      </Box>
    )

    const messages = (
      <Box key="messages" flexDirection="column">
        {note !== '' && <Box key="note"><Text>{note}</Text></Box>}
        {error !== '' && <Box key="error"><Text color="error">{error}</Text></Box>}
      </Box>
    )

    if (tab === 'create') {
      if (!Input || !Select) {
        return (
          <Box flexDirection="column">
            {tabs}
            <Button key="create:go" label="＋ Create workspace" variant="primary" onPress={() => { void $.state.set(TAB, 'list'); void $.prompt.submit({ text: createPrompt('') }) }} />
          </Box>
        )
      }
      const { value: form = null } = await $.state.get(FORM)
      const fields = form ? formFields(form.bundle) : []
      const { value: draft = {} } = await $.state.get(DRAFT)
      const { value: formBusy = '' } = await $.state.get(FORM_BUSY)
      const text = (k: string) => (typeof draft[k] === 'string' ? (draft[k] as string) : '')
      const picked = (k: string) => (Array.isArray(draft[k]) ? (draft[k] as string[]) : [])
      // Desktop and terminal draw a Client: there a multi-line field is textarea.tsx; elsewhere one line.
      const Client = 'Client' in els ? els.Client : null
      // Enter in a one-line field moves to the next one; the issue field's Enter fills from the issue.
      const { value: focused = '' } = await $.state.get(FOCUSED)
      // Text fields are textarea.tsx where a Client draws (no Enter chip, multi-line when asked);
      // elsewhere the app's one-line Input.
      const textField = (f: FormField) =>
        Client ? (
          <Client key={`f:${f.key}`} module="./textarea.tsx" props={{ value: text(f.key), placeholder: f.placeholder, multiline: f.kind === 'textarea', focused: focused === f.key }} />
        ) : (
          <Input key={`f:${f.key}`} placeholder={f.placeholder} value={text(f.key)} submitLabel={f.key === 'issue_id' ? 'fill' : 'save'} onInput={v => void setField($, f.key, v)} onSubmit={v => void setField($, f.key, v).then(() => (f.key === 'issue_id' ? fetchIssue($) : undefined))} />
        )
      return (
        <Box flexDirection="column">
          {tabs}
          {!form && <Text dimColor>Loading the form…</Text>}
          {form && <Box key="legend" marginBottom={1}><Text dimColor>Fields marked * are required.</Text></Box>}
          {form && fields.map(f => (
            <Box key={`field:${f.key}`} flexDirection="column" marginBottom={1}>
              <Text bold>{`${f.key === 'issue_id' ? `${form.trackerLabel} issue` : f.title}${f.required ? ' *' : ''}`}</Text>
              {f.help !== '' && f.key !== 'issue_id' && <Text dimColor>{f.help}</Text>}
              {(f.kind === 'text' || f.kind === 'textarea') && textField(f)}
              {f.refine !== null && (
                <Box key={`refine:${f.key}`} marginTop={1} gap={1}>
                  <Button key={`create:refine:${f.key}`} label={formBusy === 'refine' ? 'Refining…' : '✨ Refine with Claude'} variant="secondary" onPress={() => void (formBusy ? undefined : refineField($, f.key, f.refine ?? ''))} />
                  <Text dimColor>Rewrites it as a clear instruction with a goal and acceptance criteria, using the issue and your other choices.</Text>
                </Box>
              )}
              {f.kind === 'select' && (
                <Select key={`f:${f.key}`} options={[{ value: '', label: 'Choose…' }, ...f.options.map(o => ({ value: o }))]} value={text(f.key)} onSelect={v => void setField($, f.key, v)} />
              )}
              {f.kind === 'multi' && optionGroups(f).map(([group, opts]) => (
                <Box key={`group:${f.key}:${group}`} flexDirection="column" marginTop={1}>
                  {group !== '' && <Text dimColor>{group.toUpperCase()}</Text>}
                  <Box key={`opts:${f.key}:${group}`} flexWrap="wrap">
                    {opts.map(o => {
                      const chosen = picked(f.key).includes(o)
                      return (
                        <Box key={`cell:${f.key}:${o}`} width={`${100 / COLUMNS}%`}>
                          <Button key={`f:${f.key}:${o}`} plain label={`${chosen ? '☑' : '☐'} ${o}`} onPress={() => void setField($, f.key, chosen ? picked(f.key).filter(x => x !== o) : [...picked(f.key), o])} />
                        </Box>
                      )
                    })}
                  </Box>
                </Box>
              ))}
              {f.key === 'issue_id' && (
                <Box key="fetch" flexDirection="column" marginTop={1}>
                  <Text dimColor>{`Optional. Reads the issue from ${form.trackerLabel} and fills in the fields below that are still empty.`}</Text>
                  <Box key="fetch:row" marginTop={1}>
                    <Button key="create:fetch" label={formBusy === 'fetch' ? 'Reading the issue…' : '⤓ Fill empty fields from this issue'} variant="secondary" onPress={() => void (formBusy ? undefined : fetchIssue($))} />
                  </Box>
                </Box>
              )}
            </Box>
          ))}
          {form && <Box key="go"><Button key="create:go" label={formBusy === 'create' ? 'Creating…' : '＋ Create workspace'} variant="primary" onPress={() => void (formBusy ? undefined : submitForm($))} /></Box>}
          {messages}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {tabs}
        {rows.length === 0 && <Text dimColor>No workspaces.</Text>}
        {rows.map(r => (
          <Box key={`ws:${r.name}`} flexDirection="column" borderStyle="round" borderColor={BORDER[r.state]} borderDimColor={BORDER[r.state] === 'inactive' ? true : undefined} paddingX={1} marginBottom={1}>
            <Box key={`head:${r.name}`} justifyContent="space-between">
              <Box key={`row:${r.name}`}>
                <Text bold>{r.name}</Text>
                {r.issueId && <Text dimColor>{` · ${r.issueId}`}</Text>}
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
        {messages}
      </Box>
    )
  })
}
