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
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
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
