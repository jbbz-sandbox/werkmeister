export type WorkspaceState = 'up' | 'partial' | 'stopped' | 'down' | 'unknown'

export type WorkspaceRow = {
  name: string
  path: string
  issueId: string | null
  /** `task` from .sandbox/workspace.yml. */
  task: string | null
  /** `description` from .sandbox/workspace.yml. */
  description: string | null
  /** `work_type` from .sandbox/workspace.yml. */
  workType: string | null
  /** The first ICM stage whose output/ is still empty; null when not an ICM workspace or every stage has output. */
  stage: { index: number; total: number; name: string } | null
  /** Title of the workspace's newest on-disk Claude session. */
  sessionTitle: string | null
  /** That session's transcript `entrypoint`: claude-vscode, claude-desktop, sdk-cli, ...; null when unknown. */
  sessionOrigin: string | null
  state: WorkspaceState
  running: number
  total: number
  claude: 'working' | 'waiting' | null
  /** The desktop-app session whose cwd lies in this workspace. */
  session: { id: string; title: string; link: string | null } | null
}

/** Shared infra (`sandbox connect`): the `infra` block of workspace-status. */
export type InfraStatus = {
  state: 'up' | 'partial' | 'down' | 'unknown'
  running: number
  total: number
  services: { name: string; state: 'healthy' | 'starting' | 'running' | 'down' }[]
}

declare module 'claude-code' {
  interface PluginState {
    'sandbox-tools': {
      rows: WorkspaceRow[]
      error: string
      busy: string
      confirmRemove: string
      note: string
      infra: InfraStatus | null
      /** The pane's open tab. */
      tab: 'list' | 'create'
    }
  }
}
