export type WorkspaceField = {
  key: string
  label: string
  help: string
  isRequired: boolean
  isList: boolean
  options: string[]
}
export type WorkspaceForm = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'sandbox-tools': { fields: WorkspaceField[]; form: WorkspaceForm; status: string; isBusy: boolean }
  }
}
