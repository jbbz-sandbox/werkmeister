import { test, expect, mock } from 'claude-code/testing'
import { formFields, nextTextField, optionGroups } from './register'
import type { On } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const WS = 'plugin:sandbox-tools:sandbox-workspace'
const PANE_PROPS = {
  title: 'Sandbox workspaces',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type McpAnswer = { content: { type: 'text'; text: string }[]; isError: boolean; structuredContent?: unknown }
type McpStub = Record<string, (args: Record<string, unknown>) => McpAnswer | Promise<McpAnswer>>

/** Stubs every noun the module calls. `calls` records each mcp.call as `server/tool`. */
function world(on: On, stubs: McpStub = {}) {
  const calls: { key: string; args: Record<string, unknown>; via: 'mcp' | 'process' }[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  // The workspace server's tools run in a node child (the auto-mode gate refuses a plugin's own MCP call):
  // the request rides on stdin as { op, ...args }; the same `stubs` map answers by `${WS}/${op}`.
  on('process.run', async (_$, e) => {
    const { op, ...args } = JSON.parse(e.init?.stdin ?? '{}') as { op: string } & Record<string, unknown>
    const key = `${WS}/${op}`
    calls.push({ key, args, via: 'process' })
    const stub = stubs[key]
    const a = stub ? await stub(args) : { content: [{ type: 'text' as const, text: `no stub for ${key}` }], isError: true }
    const line = a.isError ? { ok: false, error: a.content[0]?.text } : { ok: true, result: a.structuredContent }
    return { value: { exitCode: 0, stdout: JSON.stringify(line) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('mcp.call', async (_$, e) => {
    const key = `${e.server}/${e.tool}`
    calls.push({ key, args: e.args, via: 'mcp' })
    const stub = stubs[key]
    if (!stub) return { value: { content: [{ type: 'text' as const, text: `no stub for ${key}` }], isError: true } }
    return { value: await stub(e.args) }
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
    [`${WS}/list-workspaces`]: () => ok({ root: '/ws', workspaces: [] }),
    [`${WS}/workspace-status`]: () => ok({ statuses: [], infra: { state: 'down', running: 0, total: 0, services: [] } }),
    'ccd_session_mgmt/list_sessions': () => ok(undefined, '[]'),
  })
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect((await ui.find({ text: /No workspaces/ }))?.text).toMatch(/No workspaces/)
    await ui.unmount()
  }
})

const LIST = {
  root: '/ws',
  workspaces: [
    { name: 'ab', path: '/ws/ab', issueId: 'PROJ-1', labels: [], task: 'BWell', description: 'BWell technologies', workType: 'spike', stage: { index: 5, total: 6, name: 'implement' }, sessionTitle: 'Demo project', sessionOrigin: 'sdk-cli' },
    { name: 'abc', path: '/ws/abc', issueId: null, labels: [], task: null, description: null, workType: 'bugfix', stage: null, sessionTitle: null, sessionOrigin: null },
    { name: 'empty', path: '/ws/empty', issueId: null, labels: [], task: null, description: null, workType: null, stage: null, sessionTitle: null, sessionOrigin: null },
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
    [`${WS}/list-workspaces`]: () => ok(LIST),
    [`${WS}/workspace-status`]: () => ok(STATUS),
    'ccd_session_mgmt/list_sessions': () => ok(undefined, JSON.stringify(SESSIONS)),
    ...over,
  }
}

test('workspace data comes from the node child, not an MCP call', async ($, on) => {
  const w = world(on, stubs())
  await openPane($)
  expect(w.calls.filter(c => c.via === 'mcp' && c.key.startsWith(WS))).toHaveLength(0)
  expect(w.calls.filter(c => c.via === 'process').map(c => c.key)).toEqual([`${WS}/list-workspaces`, `${WS}/workspace-status`])
})

test('rows draw name, issue, task, counts and claude note', async ($, on) => {
  world(on, stubs())
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect((await ui.find({ key: 'row:ab' }))?.text).toBe('ab · PROJ-1')
    expect((await ui.find({ key: 'task:ab' }))?.text).toBe('BWell')
    expect((await ui.find({ key: 'desc:ab' }))?.text).toBe('BWell technologies')
    expect((await ui.find({ key: 'meta:ab' }))?.text).toBe('spike · stage 5/6 implement · 3/3')
    expect((await ui.find({ key: 'claude:ab' }))?.text).toBe('◌ working')
    expect((await ui.find({ key: 'row:abc' }))?.text).toBe('abc')
    expect(await ui.find({ key: 'task:abc' })).toBeUndefined()
    expect(await ui.find({ key: 'desc:abc' })).toBeUndefined()
    expect((await ui.find({ key: 'meta:abc' }))?.text).toBe('bugfix · 1/3')
    expect((await ui.find({ key: 'claude:abc' }))?.text).toBe('● waiting for you')
    expect(await ui.find({ key: 'claude:empty' })).toBeUndefined()
    await ui.unmount()
  }
})

test('no counts when total is 0', async ($, on) => {
  world(on, stubs())
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect((await ui.find({ key: 'row:empty' }))?.text).toBe('empty')
    expect(await ui.find({ key: 'meta:empty' })).toBeUndefined()
    await ui.unmount()
  }
})

test('segment-aware join picks the deepest workspace and the newest session', async ($, on) => {
  world(on, stubs())
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    expect((await ui.find({ key: 'session:abc' }))?.text).toBe('session · Desktop · Newer in abc')
    expect((await ui.find({ key: 'session:ab' }))?.text).toBe('session · CLI · Demo project')
    expect(await ui.find({ key: 'session:empty' })).toBeUndefined()
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

test('a card border follows the state', async ($, on) => {
  world(on, stubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect((await ui.find({ key: 'ws:ab' }))?.props.borderColor).toBe('success')
  expect((await ui.find({ key: 'ws:abc' }))?.props.borderColor).toBe('warning')
  expect((await ui.find({ key: 'ws:empty' }))?.props.borderDimColor).toBe(true)
  await ui.unmount()
})

test('jump with no desktop session resumes the newest session in a Terminal', async ($, on) => {
  const w = world(on, stubs({ [`${WS}/claude-resume`]: () => ok({ path: '/ws/ab', sessionId: 's1' }) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'jump:ab' })
  expect(w.calls.find(c => c.key === `${WS}/claude-resume`)?.args).toEqual({ name: 'ab' })
  expect(w.calls.find(c => c.key === 'ccd_window/open_session_in')).toBeUndefined()
  await ui.unmount()
})

test('jump on a VS Code session opens the folder in VS Code, not a Terminal', async ($, on) => {
  const vscode = { ...LIST, workspaces: LIST.workspaces.map(w => (w.name === 'ab' ? { ...w, sessionOrigin: 'claude-vscode' } : w)) }
  const w = world(on, stubs({ [`${WS}/list-workspaces`]: () => ok(vscode), [`${WS}/open-vscode`]: () => ok({ path: '/ws/ab' }) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect((await ui.find({ key: 'session:ab' }))?.text).toBe('session · VS Code · Demo project')
  await ui.press({ key: 'jump:ab' })
  expect(w.calls.find(c => c.key === `${WS}/open-vscode`)?.args).toEqual({ path: '/ws/ab' })
  expect(w.calls.find(c => c.key === `${WS}/claude-resume`)).toBeUndefined()
  expect(w.toasts).toEqual(['Opening ab in VS Code'])
  await ui.unmount()
})

test('the workspace this session sits in gets no Switch', async ($, on) => {
  world(on, stubs())
  on('session.cwd', () => ({ value: '/ws/abc/repo' }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect(await ui.find({ key: 'switch:abc' })).toBeUndefined()
  expect(await ui.find({ key: 'switch:ab' })).toBeDefined()
  await ui.unmount()
})

test('a failed list keeps the last rows and shows the error', async ($, on) => {
  let fail = false
  const w = world(on, stubs({ [`${WS}/list-workspaces`]: () => (fail ? { content: [{ type: 'text', text: 'docker down' }], isError: true } : ok(LIST)) }))
  await openPane($)
  fail = true
  await w.clock.advance(5000)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect(await ui.find({ key: 'row:ab' })).toBeDefined()
  expect((await ui.find({ key: 'error' }))?.text).toBe('docker down')
  await ui.unmount()
})

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
  const w = world(on, stubs({ [`${WS}/workspace-action`]: a => ok({ command: `sandbox ${a.action}`, output: 'done', path: '/ws/ab' }, `sandbox ${a.action}\n\ndone`) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  const before = w.calls.filter(c => c.key === `${WS}/list-workspaces`).length
  await ui.press({ key: 'stop:ab' })
  const action = w.calls.find(c => c.key === `${WS}/workspace-action`)
  expect(action?.args).toEqual({ name: 'ab', action: 'stop' })
  expect(w.calls.filter(c => c.key === `${WS}/list-workspaces`).length).toBe(before + 1)
  expect((await ui.find({ key: 'note' }))?.text).toBe('sandbox stop')
  await ui.unmount()
})

test('press while busy is ignored', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => { release = r })
  const w = world(on, stubs({ [`${WS}/workspace-action`]: async () => { await gate; return ok({ command: 'x', output: '', path: '' }) } }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  const first = ui.press({ key: 'stop:ab' })
  await w.clock.settle()
  expect((await ui.find({ key: 'busy:ab' }))?.text).toBe('working…')
  await ui.press({ key: 'up:abc' })
  release()
  await first
  expect(w.calls.filter(c => c.key === `${WS}/workspace-action`)).toHaveLength(1)
  await ui.unmount()
})

test('remove needs two presses on the same workspace', async ($, on) => {
  const w = world(on, stubs({ [`${WS}/remove-workspace`]: () => ok({ command: 'sandbox remove', output: '', path: '/ws/ab' }, 'sandbox remove') }))
  await openPane($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface, component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
    await ui.press({ key: 'remove:ab' })
    expect(w.calls.filter(c => c.key === `${WS}/remove-workspace`)).toHaveLength(0)
    expect((await ui.find({ key: 'remove:ab' }))?.props.label).toBe('✕ Yes, remove')
    await ui.press({ key: 'remove:ab' })
    expect(w.calls.filter(c => c.key === `${WS}/remove-workspace`).map(c => c.args)).toEqual([{ name: 'ab' }])
    expect((await ui.find({ key: 'remove:ab' }))?.props.label).toBe('✕ Remove')
    await ui.unmount()
    w.calls.length = 0
  }
})

test("a press on another row's button clears the pending remove", async ($, on) => {
  const w = world(on, stubs({ [`${WS}/workspace-action`]: () => ok({ command: 'sandbox up', output: '', path: '' }, 'sandbox up') }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'remove:ab' })
  await ui.press({ key: 'up:abc' })
  expect((await ui.find({ key: 'remove:ab' }))?.props.label).toBe('✕ Remove')
  await ui.press({ key: 'remove:ab' })
  expect(w.calls.filter(c => c.key === `${WS}/remove-workspace`)).toHaveLength(0)
  await ui.unmount()
})

test('polls every 5 s while open', async ($, on) => {
  const w = world(on, stubs())
  await openPane($)
  const count = () => w.calls.filter(c => c.key === `${WS}/workspace-status`).length
  const n = count()
  await w.clock.advance(5000)
  expect(count()).toBe(n + 1)
  await w.clock.advance(5000)
  expect(count()).toBe(n + 2)
})

// The kit's $ cannot raise ui.close itself; a helper plugin's $.ui.close raises it the way the engine does.
const CLOSER: Plugin = {
  name: 'closer',
  register: on => {
    on('command.run', { command: 'close-workspaces' }, async $ => {
      await $.ui.close({ id: 'workspaces' })
      return { text: 'closed' }
    })
  },
}

test('closing the pane cancels the timer', { plugins: [CLOSER] }, async ($, on) => {
  const w = world(on, stubs())
  await openPane($)
  const count = () => w.calls.filter(c => c.key === `${WS}/workspace-status`).length
  const n = count()
  await w.clock.advance(5000)
  expect(count()).toBe(n + 1)
  await $.command.run({ command: 'close-workspaces', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await w.clock.advance(10000)
  expect(count()).toBe(n + 1)
})

test('a slow tick is skipped, not queued', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => { release = r })
  let held = 0
  const w = world(on, stubs({ [`${WS}/list-workspaces`]: async () => { if (held++ === 1) await gate; return ok(LIST) } }))
  await openPane($)
  await w.clock.advance(5000)
  await w.clock.advance(5000)
  await w.clock.advance(5000)
  release()
  await w.clock.settle()
  expect(w.calls.filter(c => c.key === `${WS}/list-workspaces`)).toHaveLength(2)
})

test('switch calls change_directory, toasts, and submits a turn so the move lands', async ($, on) => {
  const w = world(on, stubs({ 'ccd_directory/change_directory': () => ok(undefined, 'Access granted.') }))
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'switch:abc' })
  expect(w.calls.find(c => c.key === 'ccd_directory/change_directory')?.args).toEqual({ path: '/ws/abc' })
  expect(w.toasts).toEqual(['Switching to abc'])
  expect(submitted).toEqual(['Switched to workspace abc. Read /ws/abc/CLAUDE.md, then wait for my next instruction.'])
  await ui.unmount()
})

test('jump focuses a session this session started, else toasts its title', async ($, on) => {
  const w = world(on, stubs({ 'ccd_window/open_session_in': () => ({ content: [{ type: 'text', text: 'Only sessions this session started can be focused.' }], isError: true }) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'jump:abc' })
  expect(w.calls.find(c => c.key === 'ccd_window/open_session_in')?.args).toEqual({ session_id: 'local_1', target: 'focus' })
  expect(w.toasts).toEqual(['Open "Newer in abc" from the sidebar'])
  await ui.unmount()
})

test('a session starting in a folder of workspaces opens the pane; elsewhere it does not', async ($, on) => {
  const w = world(on, stubs())
  // Opening the pane loads the list once.
  const opened = () => w.calls.filter(c => c.key === `${WS}/list-workspaces`).length
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.list', (_$, e) => ({ value: e.path === '/features' ? [{ name: 'ab', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/features/ab/.sandbox/workspace.yml' }))
  await $.session.start({ cwd: '/elsewhere', surface: 'desktop', isInteractive: true })
  expect(opened()).toBe(0)
  await $.session.start({ cwd: '/features', surface: null, isInteractive: false })
  expect(opened()).toBe(0)
  await $.session.start({ cwd: '/features', surface: 'desktop', isInteractive: true })
  expect(opened()).toBe(1)
})

const BUNDLE = {
  schema: {
    properties: {
      issue_id: { type: 'string', title: 'GitHub issue (blank to skip)', pattern: '^$|(?:^([A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+#[0-9]+$)' },
      feature: { type: 'string', title: 'Feature name', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
      work_type: { type: 'string', title: 'Work type', enum: ['feature', 'bugfix'] },
      services: { type: 'array', title: 'Local services', items: { enum: ['api', 'web'] } },
      task: { type: 'string', title: 'Task title (Enter for default)', description: 'Short title for the Current Task section.' },
      starting_prompt: { type: 'string', title: 'Starting prompt (blank to skip)' },
    },
    required: ['feature', 'work_type'],
  },
  uiSchema: {
    'ui:order': ['issue_id', 'feature', 'work_type', 'services', 'task', 'starting_prompt'],
    feature: { 'ui:placeholder': 'my-feature' },
    services: { 'ui:widget': 'checkboxes', 'ui:options': { groups: { web: ['web'], core: ['api'] } } },
    starting_prompt: { 'ui:widget': 'textarea' },
  },
  formData: {},
}

function formStubs(over: Partial<McpStub> = {}): McpStub {
  return stubs({
    [`${WS}/form-schema`]: () => ok({ bundle: BUNDLE, trackerLabel: 'GitHub' }),
    [`${WS}/issue-form-data`]: () => ok({ issue_id: 'acme/api#7', feature: 'rate-limit', task: 'Rate limit the API', services: ['api'] }),
    [`${WS}/create-workspace`]: () => ok({ command: 'sandbox workspace rate-limit', workspacePath: '/ws/api-7-rate-limit' }),
    ...over,
  })
}

test('the Create tab draws the form from the schema: titles without wizard hints, the issue named for the tracker', async ($, on) => {
  world(on, formStubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect(await ui.find({ key: 'create:go' })).toBeUndefined()
  await ui.press({ key: 'tab:create' })
  for (const key of ['f:issue_id', 'f:feature', 'f:work_type', 'f:services:api', 'f:services:web', 'f:task', 'f:starting_prompt']) expect(await ui.find({ key })).toBeDefined()
  expect((await ui.find({ key: 'f:starting_prompt' }))?.type).toBe('Client')
  expect((await ui.find({ text: 'GitHub issue' }))).toBeDefined()
  expect((await ui.find({ text: 'Task title' }))).toBeDefined()
  expect((await ui.find({ text: 'Feature name *' }))).toBeDefined()
  expect((await ui.find({ text: 'Short title for the Current Task section.' }))).toBeDefined()
  expect((await ui.find({ key: 'create:fetch' }))?.text).toBe('⤓ Fill empty fields from this issue')
  await ui.unmount()
})

test('the multi-line field types across lines and its text reaches the create call', async ($, on) => {
  const w = world(on, formStubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'tab:create' })
  for (const key of ['a', 'b', 'return', 'c', 'backspace', 'd', 'up', 'end', '!']) await ui.key({ key, in: 'f:starting_prompt' })
  await ui.input({ key: 'f:feature', text: 'x', kind: 'change' })
  await ui.select({ key: 'f:work_type', value: 'feature' })
  await ui.press({ key: 'create:go' })
  expect((w.calls.find(c => c.key === `${WS}/create-workspace`)?.args as { formData: Record<string, unknown> }).formData.starting_prompt).toBe('ab!\nd')
  await ui.unmount()
})

test('Enter in a one-line field keeps its value; the next field it moves to skips selects, picks and multi-line fields', async ($, on) => {
  const w = world(on, formStubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'tab:create' })
  await ui.input({ key: 'f:feature', text: 'x' })
  await ui.select({ key: 'f:work_type', value: 'feature' })
  await ui.press({ key: 'create:go' })
  expect((w.calls.find(c => c.key === `${WS}/create-workspace`)?.args as { formData: Record<string, unknown> }).formData.feature).toBe('x')
  await ui.unmount()
  const fields = formFields(BUNDLE)
  expect(nextTextField(fields, 'feature')).toBe('task')
  expect(nextTextField(fields, 'task')).toBeNull()
})

test('fetch fills only the empty fields, then create submits the draft and returns to the list', async ($, on) => {
  const w = world(on, formStubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'tab:create' })
  await ui.input({ key: 'f:feature', text: 'my-own', kind: 'change' })
  await ui.input({ key: 'f:issue_id', text: 'api#7', kind: 'change' })
  await ui.press({ key: 'create:fetch' })
  expect(w.calls.find(c => c.key === `${WS}/issue-form-data`)?.args).toEqual({ ref: 'api#7' })
  expect((await ui.find({ text: /^Filled / }))?.text).toBe('Filled task, services from acme/api#7.')
  await ui.press({ key: 'f:services:web' })
  await ui.select({ key: 'f:work_type', value: 'bugfix' })
  await ui.press({ key: 'create:go' })
  expect(w.calls.find(c => c.key === `${WS}/create-workspace`)?.args).toEqual({
    formData: { feature: 'my-own', issue_id: 'acme/api#7', task: 'Rate limit the API', services: ['api', 'web'], work_type: 'bugfix' },
  })
  expect(w.toasts).toEqual(['Workspace created'])
  expect(await ui.find({ key: 'switch:abc' })).toBeDefined()
  await ui.unmount()
})

test('create with a required field empty or a bad value says why and creates nothing', async ($, on) => {
  const w = world(on, formStubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'tab:create' })
  await ui.input({ key: 'f:feature', text: 'Not A Slug', kind: 'change' })
  await ui.press({ key: 'create:go' })
  expect((await ui.find({ text: /Work type: required/ }))?.text).toMatch(/Feature name: "Not A Slug" doesn't match[\s\S]*Work type: required/)
  expect(w.calls.some(c => c.key === `${WS}/create-workspace`)).toBe(false)
  await ui.unmount()
})

test('a multi-pick draws as checkboxes under its group headings, sorted, each in a fifth-width column', async ($, on) => {
  world(on, formStubs())
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'tab:create' })
  expect(await ui.find({ text: 'CORE' })).toBeDefined()
  expect(await ui.find({ text: 'WEB' })).toBeDefined()
  expect((await ui.find({ key: 'f:services:api' }))?.text).toBe('☐ api')
  await ui.press({ key: 'f:services:api' })
  expect((await ui.find({ key: 'f:services:api' }))?.text).toBe('☑ api')
  expect((await ui.find({ key: 'cell:services:api' }))?.props.width).toBe('20%')
  await ui.unmount()
  const f = formFields(BUNDLE).find(x => x.key === 'services')!
  expect(optionGroups(f)).toEqual([['core', ['api']], ['web', ['web']]])
  expect(optionGroups({ ...f, groups: { core: ['api'] } })).toEqual([['core', ['api']], ['other', ['web']]])
  expect(optionGroups({ ...f, groups: {} })).toEqual([['', ['api', 'web']]])
})
