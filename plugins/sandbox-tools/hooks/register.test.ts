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
