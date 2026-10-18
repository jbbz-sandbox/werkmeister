export type WorkspaceState = "up" | "partial" | "stopped" | "down" | "unknown";

export type WorkspaceRow = {
  name: string;
  path: string;
  issueId: string | null;
  /** The issue's page in the configured tracker; null when it can't be built from config. */
  issueUrl: string | null;
  /** `task` from .sandbox/workspace.yml. */
  task: string | null;
  /** `description` from .sandbox/workspace.yml. */
  description: string | null;
  /** `work_type` from .sandbox/workspace.yml. */
  workType: string | null;
  /** `feature` from .sandbox/workspace.yml: the key intercept rows and slots are filed under. */
  feature: string | null;
  /** The first ICM stage whose output/ is still empty; null when not an ICM workspace or every stage has output. */
  stage: { index: number; total: number; name: string } | null;
  /** sandbox-core `lifecycleOf` — PR files only, no network; null when it could not be read. */
  lifecycle: {
    state: "working" | "ready" | "pr-open" | "merged" | "shipped" | "closed-out" | "abandoned";
    prs: { dir: string; status: string; url: string | null }[];
  } | null;
  /** Title of the workspace's newest on-disk Claude session. */
  sessionTitle: string | null;
  /** That session's transcript `entrypoint`: claude-vscode, claude-desktop, sdk-cli, ...; null when unknown. */
  sessionOrigin: string | null;
  state: WorkspaceState;
  running: number;
  total: number;
  services: ServiceHealth[];
  claude: "working" | "waiting" | null;
  /** The desktop-app session whose cwd lies in this workspace. */
  /** `beside`: this session started it, so the app will open it in split view next to this one. */
  /** `pinned`: the session is pinned in the app's sidebar. */
  session: {
    id: string;
    title: string;
    link: string | null;
    beside: boolean;
    pinned: boolean;
  } | null;
};

/** One repo worktree's PR for its branch (sandbox-core getWorkspacePRs, via `gh`); url null when it has none. */
export type RepoPr = {
  repo: string;
  url: string | null;
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  title: string | null;
};

/** One container's health, as workspace-status reports it. */
export type ServiceHealth = { name: string; state: "healthy" | "starting" | "running" | "down" };

/** Shared infra (`sandbox connect`): the `infra` block of workspace-status. */
export type InfraStatus = {
  state: "up" | "partial" | "down" | "unknown";
  running: number;
  total: number;
  services: ServiceHealth[];
};

/** One feature×service row of `sandbox status --intercepts --json` (sandbox-core `InterceptRow`). */
export type InterceptRow = {
  feature: string;
  service: string;
  deployment: string | null;
  interceptable: boolean;
  blocker: string | null;
  intercepted: boolean;
  /** Null when the owning feature can't be read: never treat that intercept as yours. */
  intercepted_by: string | null;
};

/** What `sandbox status --intercepts --json` prints (sandbox-core `InterceptsSnapshot`). */
export type InterceptsSnapshot = {
  available: boolean;
  connected_namespace: string | null;
  intercepts: InterceptRow[];
};

/** One field of the Create tab's form, from the RJSF bundle getFormSchema builds. */
export type FormField = {
  key: string;
  title: string;
  /** The schema's description: one line under the title. */
  help: string;
  kind: "text" | "textarea" | "select" | "multi" | "check";
  options: string[];
  /** A multi-pick's options by group heading (`ui:options.groups`); {} draws them ungrouped. */
  groups: Record<string, string[]>;
  /** A refinable field's instruction for buildRefinePrompt ("" = its default); null when it has no Refine button. */
  refine: string | null;
  required: boolean;
  pattern: string | null;
  placeholder: string;
};

/** The RJSF bundle getFormSchema builds: what the browser form renders, and the Create tab too. */
export type FormBundle = {
  schema: {
    properties?: Record<
      string,
      {
        title?: string;
        description?: string;
        type?: string;
        enum?: string[];
        pattern?: string;
        items?: { enum?: string[] };
      }
    >;
    required?: string[];
  };
  uiSchema: Record<string, unknown>;
  formData: Draft;
};

/** The Create tab's values by field key; a multi-pick is a list. */
export type Draft = Record<string, string | string[] | boolean>;

declare module "claude-code" {
  interface PluginState {
    werkmeister: {
      rows: WorkspaceRow[];
      error: string;
      busy: string;
      /** `close-out:<name>`, `abandon:<name>` or `intercept:<name>/<service>` between a button's two presses; '' when none is pending. */
      confirmEnd: string;
      /** The reason typed for a pending abandon. */
      abandonReason: string;
      note: string;
      infra: InfraStatus | null;
      /** The last intercept read; null when it failed or timed out. */
      intercepts: InterceptsSnapshot | null;
      /** The configured issue tracker's sign-in check; null until checked or if the check failed. */
      tracker: { ok: boolean; reason?: string; fix: string } | null;
      /** Each workspace's repo PRs by workspace name; refreshed slower than rows, as each is a `gh` call. */
      prs: Record<string, RepoPr[]>;
      /** The pane's open tab. */
      tab: "list" | "create";
      /** List only workspaces labelled `focus`. */
      focus: boolean;
      /**
       * The Create tab's form as loaded and the tracker's name; null until loaded. The raw
       * bundle, not the fields: state outlives a plugin reload, and fields are drawn from it fresh.
       */
      formSchema: { bundle: FormBundle; trackerLabel: string } | null;
      draft: Draft;
      /** '' idle, or what the Create tab is waiting on. */
      formBusy: "" | "fetch" | "create" | "refine";
      /** The Create tab's last-clicked text field, by key: the one drawn with a cursor. */
      focusedField: string;
    };
  }
}
