export type WorkspaceState = 'up' | 'partial' | 'stopped' | 'down' | 'unknown'

export type WorkspaceRow = {
  name: string
  path: string
  jiraId: string | null
  state: WorkspaceState
  running: number
  total: number
  claude: 'working' | 'waiting' | null
  session: { id: string; title: string; link: string | null } | null
}

declare module 'claude-code' {
  interface PluginState {
    'sandbox-tools': {
      rows: WorkspaceRow[]
      error: string
      busy: string
      confirmRemove: string
      note: string
    }
  }
}
