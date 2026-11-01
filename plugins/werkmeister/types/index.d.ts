export type WorkspaceState = "up" | "partial" | "stopped" | "paused" | "down" | "unknown";

export type WorkspaceRow = {
  name: string;
  path: string;
  issueId: string | null;
  /** The issue's page in the configured tracker; null when it can't be built from config. */
  issueUrl: string | null;
  /** Free-form tags from `.werkmeister/workspace.yml`'s `labels` list; `focus` drives the pane's Focused only toggle. */
  labels: string[];
  /** `task` from .werkmeister/workspace.yml. */
  task: string | null;
  /** `description` from .werkmeister/workspace.yml. */
  description: string | null;
  /** `work_type` from .werkmeister/workspace.yml. */
  workType: string | null;
  /** `feature` from .werkmeister/workspace.yml: the key intercept rows and slots are filed under. */
  feature: string | null;
  /** The first ICM stage whose output/ is still empty; null when not an ICM workspace or every stage has output. */
  stage: { index: number; total: number; name: string } | null;
  /** werkmeister-core `lifecycleOf` — PR files only, no network; null when it could not be read. */
  lifecycle: {
    state: "working" | "ready" | "pr-open" | "merged" | "shipped" | "closed-out" | "abandoned";
    prs: { dir: string; status: string; url: string | null }[];
  } | null;
  /** Title of the workspace's newest on-disk Claude session; the card shows none (SW-52), Continue needs one. */
  sessionTitle: string | null;
  /** That session's transcript `entrypoint`: claude-vscode, claude-desktop, sdk-cli, ...; null when unknown. */
  sessionOrigin: string | null;
  state: WorkspaceState;
  running: number;
  total: number;
  services: ServiceHealth[];
  /** The agent state core reports (SW-46): idle with no status, `at` and `question` null when unknown. */
  claude: {
    agent: "working" | "needs-you" | "done" | "idle";
    at: string | null;
    question: string | null;
  };
  /** JIT phase from the newest live note (SW-47), or null. */
  phase: string | null;
  /** `autonomous` in workspace.yml. */
  autonomous: boolean;
  /** mtime (ISO) of the newest Claude transcript, or null. */
  lastActivity: string | null;
  /** `werkmeister-<feature>`: the key resources are joined on (SW-41). */
  project: string | null;
  /** The earliest running container's start and what started it; null when none runs. */
  started: { at: string; by: "up" | "gate" | "restart" | "person" } | null;
  /** Containers restarting under their restart policy, with their last log line. */
  crashLoops: { service: string; restarts: number; lastLog: string | null }[];
  /** Held by Pause (SW-70): when, and the containers Resume brings back; null when not paused. */
  paused: { at: string; containers: string[] } | null;
  /** Resume left a "continue" for this workspace's live session, for the pane to send. */
  resumeNudge: boolean;
  /** The desktop-app session whose cwd lies in this workspace. */
  /** `pinned`: the session is pinned in the app's sidebar. */
  session: {
    id: string;
    title: string;
    link: string | null;
    pinned: boolean;
  } | null;
};

/** One repo worktree's PR for its branch (werkmeister-core getWorkspacePRs, via `gh`); url null when it has none. */
export type RepoPr = {
  repo: string;
  url: string | null;
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  title: string | null;
  /** Absent from a core older than SW-47. */
  ci?: "pass" | "running" | "fail" | null;
  failingChecks?: number;
};

/** One container's health, as workspace-status reports it. */
export type ServiceHealth = {
  name: string;
  state: "healthy" | "starting" | "unhealthy" | "running" | "down";
};

/** Shared infra (`werkmeister infra connect`): the `infra` block of workspace-status. */
export type InfraStatus = {
  state: "up" | "partial" | "down" | "unknown";
  running: number;
  total: number;
  services: ServiceHealth[];
};

/** werkmeister-core `getWorkspaceResources`: one stats sweep, CPU in % of one core. */
export type WorkspaceResources = {
  projects: Record<string, { cpuPercent: number; memMib: number }>;
  host: { load: [number, number, number]; cores: number; featureCpuPercent: number };
};

/** One feature×service row of `werkmeister feature status --intercepts --json` (werkmeister-core `InterceptRow`). */
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

/** What `werkmeister feature status --intercepts --json` prints (werkmeister-core `InterceptsSnapshot`). */
export type InterceptsSnapshot = {
  available: boolean;
  /** On PATH, connected or not. Absent from a core older than SW-12: fall back to `available`. */
  installed?: boolean;
  connected_namespace: string | null;
  intercepts: InterceptRow[];
  /** Registry services with k8s coordinates; the rest get no intercept control. */
  remote_services: string[];
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

/** One `## ` question of a Markdown form, as werkmeister-core's parseForm gives it (md_form.ts). */
export type FormQuestion = {
  key: string;
  heading: string;
  required: boolean;
  status: "proposed" | "decided" | null;
  kind: "one" | "any" | null;
  options: {
    value: string;
    checked: boolean;
    recommended: boolean;
    other: boolean;
    otherText: string;
  }[];
  boxes: { label: string }[];
  context: string[];
};

/** Per question key: picked option values, the Other text, box text by label. */
export type FormAnswers = Record<
  string,
  { picked?: string[]; other?: string; boxes?: Record<string, string> }
>;

/** werkmeister-core's openForms row: one gate file with a proposed question; `draft` is what the sheet edits. */
export type OpenForm = {
  workspace: string;
  path: string;
  rel: string;
  md: string;
  hash: string;
  form: { title: string | null; questions: FormQuestion[] };
  draft: FormAnswers;
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
      /** The last stats sweep, refreshed slower than rows; null when it failed, unset before the first. */
      resources: WorkspaceResources | null;
      /** The last intercept read; null when it failed or timed out. */
      intercepts: InterceptsSnapshot | null;
      /** The configured issue tracker's sign-in check; null until checked or if the check failed. */
      tracker: { ok: boolean; reason?: string; fix: string } | null;
      /** Each workspace's repo PRs by workspace name; unset before the first poll (cards say `loading…`), refreshed slower than rows, as each is a `gh` call. */
      prs: Record<string, RepoPr[]>;
      /** How the last PR poll ended; `failed` reads `PRs unavailable · retry` on the cards. */
      prsPoll: "ok" | "failed";
      /** The ? legend is shown. */
      legend: boolean;
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
      /** Open forms (gate files with a proposed question) as last read, drawn on their workspace cards; null before the first read. */
      forms: OpenForm[] | null;
      /**
       * Sheets the person has touched, by file path, frozen as they were first drawn: a poll never
       * swaps the hash under a draft, so Submit still refuses a file edited since (SW-309).
       */
      sheets: Record<string, OpenForm>;
      /** Why a sheet's last Submit was refused, by file path. */
      sheetErrors: Record<string, string[]>;
      /** The file path whose Submit is running; '' when none. */
      submitting: string;
      /** The file path whose sheet is open inside its card; '' when none. */
      openSheet: string;
      /** How the last open-forms read ended; `failed` draws one warning line on the list. */
      formsPoll: "ok" | "failed";
    };
  }
}
