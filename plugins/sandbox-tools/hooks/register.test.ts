import { test, expect, mock } from 'claude-code/testing'
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

test('the Create tab submits the workspace skill prompt with the typed issue ID, then returns to the list', async ($, on) => {
  const w = world(on, stubs())
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect(await ui.find({ key: 'create:go' })).toBeUndefined()
  await ui.press({ key: 'tab:create' })
  await ui.input({ key: 'create:issue', text: 'PROJ-9', kind: 'change' })
  await ui.press({ key: 'create:go' })
  expect(submitted).toEqual(['Create a new sandbox workspace with the sandbox-workspace skill, pre-filled from issue PROJ-9.'])
  expect(w.toasts).toEqual(['Opening the workspace form'])
  expect(await ui.find({ key: 'switch:abc' })).toBeDefined()
  await ui.unmount()
})

test('Connect runs sandbox connect, refreshes, and the infra line shows status', async ($, on) => {
  const infra = { state: 'partial', running: 2, total: 3, services: [{ name: 'caddy', state: 'healthy' }, { name: 'jaeger', state: 'running' }, { name: 'k8s-forwards', state: 'starting' }] }
  const w = world(on, stubs({
    [`${WS}/workspace-status`]: () => ok({ ...STATUS, infra }),
    [`${WS}/connect`]: () => ok({ ok: true }),
  }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect((await ui.find({ key: 'infra' }))?.text).toBe('infra · partial · 2/3 · starting: k8s-forwards')
  const before = w.calls.filter(c => c.key === `${WS}/workspace-status`).length
  await ui.press({ key: 'connect' })
  expect(w.calls.filter(c => c.key === `${WS}/connect`)).toHaveLength(1)
  expect(w.calls.filter(c => c.key === `${WS}/workspace-status`).length).toBe(before + 1)
  expect((await ui.find({ key: 'note' }))?.text).toBe('sandbox connect: done')
  await ui.unmount()
})
