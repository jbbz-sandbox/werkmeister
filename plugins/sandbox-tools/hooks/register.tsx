import type { Register } from 'claude-code'

import type { WorkspaceField } from '../types'

const PANE = 'workspace-form'
const FIELDS = { plugin: 'sandbox-tools', key: 'fields' } as const
const FORM = { plugin: 'sandbox-tools', key: 'form' } as const
const STATUS = { plugin: 'sandbox-tools', key: 'status' } as const
const BUSY = { plugin: 'sandbox-tools', key: 'isBusy' } as const

// Runs sandbox-core in a node child: the mod's own environment has no Node. The core is found
// from $SANDBOX_CORE_PATH, else from where the `sandbox` binary resolves its dependencies.
// Prints one JSON line: { ok, result | error }.
const SCRIPT = `
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
const out = o => console.log(JSON.stringify(o))
try {
  let file = process.env.SANDBOX_CORE_PATH
  if (!file) {
    const bin = realpathSync(execFileSync('sh', ['-c', 'command -v sandbox']).toString().trim())
    file = createRequire(dirname(bin) + '/x').resolve('sandbox-core')
  }
  const core = await import(pathToFileURL(file).href)
  if (ACTION === 'schema') out({ ok: true, result: await core.getFormSchema() })
  else {
    let s = ''
    for await (const c of process.stdin) s += c
    out({ ok: true, result: await core.createWorkspace(JSON.parse(s), { open: false }) })
  }
} catch (e) {
  out({ ok: false, error: (e && e.message) || String(e) })
}
`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'workspace-form', description: 'Fill in a form and create a sandbox workspace' })

    return next(e)
  })

  on('command.run', { command: 'workspace-form' }, async $ => {
    await $.state.set(BUSY, true)
    await $.state.set(STATUS, 'Loading the form…')
    await $.ui.open({ id: PANE, title: 'New sandbox workspace' })

    const r = await $.process.run(['node', '--input-type=module', '-e', `const ACTION = 'schema'\n${SCRIPT}`], { timeoutMs: 30000 })
    const line = r.stdout.trim().split('\n').pop() ?? ''
    try {
      const o = JSON.parse(line) as { ok: boolean; result?: { schema: Record<string, any>; uiSchema: Record<string, any> }; error?: string }
      if (!o.ok || !o.result) throw new Error(o.error)
      const { schema, uiSchema } = o.result
      const props = schema.properties as Record<string, any>
      const order: string[] = uiSchema['ui:order'] ?? Object.keys(props)
      const fields: WorkspaceField[] = order.map(key => {
        const p = props[key]
        const isList = p.type === 'array'

        return {
          key,
          label: p.title ?? key,
          help: p.description ?? '',
          isRequired: (schema.required ?? []).includes(key),
          isList,
          options: isList ? (p.items?.enum ?? []) : (p.enum ?? []),
        }
      })
      await $.state.set(FIELDS, fields)
      await $.state.set(STATUS, '')
    } catch (err) {
      await $.state.set(STATUS, `Could not load the form: ${(err as Error).message || r.stderr.trim() || 'is sandbox-core installed? set SANDBOX_CORE_PATH'}`)
    }
    await $.state.set(BUSY, false)

    return { text: 'Workspace form opened.' }
  })

  on('ui.press', { plugin: 'sandbox-tools' }, async ($, e, next) => {
    if (e.element === 'reset') {
      await $.state.set(FORM, {})
      await $.state.set(STATUS, '')
    }
    if (e.element === 'create') {
      const { value: form = {} } = await $.state.get(FORM)
      const { value: fields = [] } = await $.state.get(FIELDS)
      const { value: isBusy = false } = await $.state.get(BUSY)
      if (isBusy) return next(e)

      const missing = fields.filter(f => f.isRequired && !(form[f.key] ?? '').trim()).map(f => f.label)
      if (missing.length > 0) {
        await $.state.set(STATUS, `Required: ${missing.join(', ')}`)

        return next(e)
      }
      const data: Record<string, string | string[]> = {}
      for (const f of fields) {
        const v = (form[f.key] ?? '').trim()
        if (v) data[f.key] = f.isList ? v.split(',').map(s => s.trim()).filter(Boolean) : v
      }
      await $.state.set(BUSY, true)
      await $.state.set(STATUS, `Creating ${data.feature}…`)
      const r = await $.process.run(['node', '--input-type=module', '-e', `const ACTION = 'create'\n${SCRIPT}`], {
        stdin: JSON.stringify(data),
        timeoutMs: 600000,
      })
      let text: string
      try {
        const o = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as { ok: boolean; result?: { workspacePath: string | null; output: string }; error?: string }
        text = o.ok ? `Created ${o.result?.workspacePath ?? ''}\n${o.result?.output ?? ''}` : (o.error ?? 'Failed.')
      } catch {
        text = r.stderr.trim() || 'No result from sandbox-core.'
      }
      await $.state.set(STATUS, text)
      await $.state.set(BUSY, false)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const { value: fields = [] } = await $.state.get(FIELDS)
    const { value: form = {} } = await $.state.get(FORM)
    const { value: status = '' } = await $.state.get(STATUS)
    const { value: isBusy = false } = await $.state.get(BUSY)

    return (
      <Box flexDirection="column">
        {fields.map((f, i) => {
          const label = `${f.label}${f.isRequired ? ' *' : ''}${f.isList && f.options.length > 0 ? ` [${f.options.join(', ')}]` : ''}`
          const key = f.key
          const set = async (v: string) => {
            const { value: now = {} } = await $.state.get(FORM)
            await $.state.set(FORM, { ...now, [key]: v })
          }

          return !f.isList && f.options.length > 0 ? (
            <Select key={key} label={label} value={form[key] ?? ''} options={['', ...f.options].map(o => ({ value: o, label: o || '(none)' }))} onSelect={set} />
          ) : (
            <Input key={key} label={label} value={form[key] ?? ''} autoFocus={i === 0 ? true : undefined} onInput={set} onSubmit={() => undefined} />
          )
        })}
        <Box>
          <Button key="create" label={isBusy ? 'Working…' : 'Create workspace'} variant="primary" />
          <Button key="reset" label="Reset" />
        </Box>
        {status !== '' && <Text>{status}</Text>}
      </Box>
    )
  })
}
