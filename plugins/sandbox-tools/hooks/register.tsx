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
        <Button key="refresh" label="Refresh" onPress={() => void tick($)} />
      </Box>
    )
  })
}
