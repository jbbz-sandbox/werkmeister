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

/** One field of the Create tab's form, from the RJSF bundle getFormSchema builds. */
export type FormField = {
  key: string
  title: string
  /** The schema's description: one line under the title. */
  help: string
  kind: 'text' | 'textarea' | 'select' | 'multi'
  options: string[]
  /** A multi-pick's options by group heading (`ui:options.groups`); {} draws them ungrouped. */
  groups: Record<string, string[]>
  /** A refinable field's instruction for refinePrompt ("" = its default); null when it has no Refine button. */
  refine: string | null
  required: boolean
  pattern: string | null
  placeholder: string
}

/** The RJSF bundle getFormSchema builds: what the browser form renders, and the Create tab too. */
export type FormBundle = {
  schema: {
    properties?: Record<string, { title?: string; description?: string; type?: string; enum?: string[]; pattern?: string; items?: { enum?: string[] } }>
    required?: string[]
  }
  uiSchema: Record<string, unknown>
  formData: Draft
}

/** The Create tab's values by field key; a multi-pick is a list. */
export type Draft = Record<string, string | string[]>

declare module 'claude-code' {
  interface PluginState {
    'sandbox-tools': {
      rows: WorkspaceRow[]
      error: string
      busy: string
      confirmRemove: string
      note: string
      /** The pane's open tab. */
      tab: 'list' | 'create'
      /**
       * The Create tab's form as loaded and the tracker's name; null until loaded. The raw
       * bundle, not the fields: state outlives a plugin reload, and fields are drawn from it fresh.
       */
      formSchema: { bundle: FormBundle; trackerLabel: string } | null
      draft: Draft
      /** '' idle, or what the Create tab is waiting on. */
      formBusy: '' | 'fetch' | 'create' | 'refine'
      /** The Create tab's last-clicked text field, by key: the one drawn with a cursor. */
      focusedField: string
    }
  }
}
