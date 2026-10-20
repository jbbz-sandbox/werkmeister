import type { EngineInterface, Register } from "claude-code";

import type {
  Draft,
  FormBundle,
  FormField,
  InfraStatus,
  InterceptRow,
  InterceptsSnapshot,
  RepoPr,
  ServiceHealth,
  WorkspaceRow,
} from "../types";

export const PLUGIN = "werkmeister";
export const PANE = "workspaces";

// Workspace reads and actions run sandbox-core in a node child, the way the former /workspace-form mod did:
// the plugin's own MCP server is not answerable from a hook in the desktop host, a host process is.
// stdin carries one JSON request { op, ...args }; stdout ends with one JSON line { ok, result | error }.
// The core package is found from $WERKMEISTER_CORE_PATH or $SANDBOX_CORE_PATH, else from where the `werkmeister`
// (or deprecated `sandbox`) binary resolves its dependencies: `werkmeister-core`, or `sandbox-core` before SW-6's rename.
const SCRIPT = `
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { realpathSync, readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const out = o => console.log(JSON.stringify(o))
try {
  let s = ''
  for await (const c of process.stdin) s += c
  const { op, ...args } = JSON.parse(s)
  let file = process.env.WERKMEISTER_CORE_PATH ?? process.env.SANDBOX_CORE_PATH
  if (!file) {
    const bin = realpathSync(execFileSync('sh', ['-c', 'command -v werkmeister || command -v sandbox']).toString().trim())
    const req = createRequire(dirname(bin) + '/x')
    try { file = req.resolve('werkmeister-core') } catch { file = req.resolve('sandbox-core') }
  }
  const core = await import(pathToFileURL(file).href)
  const yaml = createRequire(file)('yaml')
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const lifecycleOf = dir => { try { return core.lifecycleOf(dir) } catch { return null } }
  // The transcript's "entrypoint" field (claude-vscode, claude-desktop, sdk-cli, ...) from its first 64 KiB; null when unknown.
  const originOf = (dir, sessionId) => {
    const enc = p => p.replace(/[^a-zA-Z0-9]/g, '-')
    const root = join(homedir(), '.claude', 'projects')
    let fd = null
    try {
      const proj = readdirSync(root).find(n => enc(n) === enc(dir))
      if (!proj) return null
      fd = openSync(join(root, proj, sessionId + '.jsonl'), 'r')
      const buf = Buffer.alloc(65536)
      const head = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0))
      return head.match(/"entrypoint":"([^"]+)"/)?.[1] ?? null
    } catch { return null } finally { if (fd !== null) closeSync(fd) }
  }
  const tracker = (await import(pathToFileURL(join(dirname(file), 'issue_tracker.js')).href)).issueTracker()
  // core.icmStage is absent from a core older than SW-47: show no stage rather than fail the list.
  const details = async w => {
    let cfg = {}
    for (const d of ['.werkmeister', '.sandbox']) {
      try { cfg = yaml.parse(readFileSync(join(w.path, d, 'workspace.yml'), 'utf8')) ?? {}; break } catch { /* not initialised */ }
    }
    let newest = null
    try { newest = (await core.listSessions(w.name))[0] ?? null } catch { /* no sessions */ }
    const sessionOrigin = newest ? originOf(w.path, newest.sessionId) : null
    return { ...w, issueUrl: w.issueId ? tracker.url(w.issueId) : null, task: str(cfg.task), description: str(cfg.description), workType: str(cfg.work_type), feature: str(cfg.feature), stage: core.icmStage ? await core.icmStage(w.path) : null, lifecycle: lifecycleOf(w.path), sessionTitle: newest?.title ?? null, sessionOrigin }
  }
  // Siblings of the resolved entry: the main entry exports none of the intercept functions.
  const sibling = name => import(pathToFileURL(join(dirname(file), name)).href)
  const interceptArgs = async () => ({
    feature: args.feature,
    service: args.service,
    localServices: (await sibling('lifecycle.js')).readServicesFromWorkspace(await core.resolveWorkspaceDir(args.name)),
  })
  const ops = {
    'list-workspaces': async () => { const r = await core.listWorkspaces(); return { ...r, workspaces: await Promise.all(r.workspaces.map(details)) } },
    'workspace-status': () => core.getWorkspaceStatuses(),
    // The same snapshot \`sandbox status --intercepts --json\` prints: the CLI stays the one source of intercept state.
    intercepts: async () => (await sibling('status.js')).interceptsSnapshot(),
    'intercept-start': async () => (await sibling('telepresence.js')).startIntercept(await interceptArgs()),
    'intercept-leave': async () => ({ left: await (await sibling('telepresence.js')).leaveIntercept(await interceptArgs()) }),
    'workspace-prs': () => core.getWorkspacePRs(),
    connect: async () => ({ ok: await (await import(pathToFileURL(join(dirname(file), 'infra.js')).href)).up() }),
    'workspace-action': () => core.runWorkspaceAction(args.name, args.action),
    'workspace-path': async () => ({ path: await core.resolveWorkspaceDir(args.name) }),
    'pr-status': async () => ({ command: (await core.refreshPrStatus(args.path)).lines.join('\\n') || 'no PR files' }),
    'pr-watch': () => core.watchPrs({ desktop: true }),
    'close-out': () => core.closeOut(args.name, args.abandon !== undefined ? { abandon: args.abandon } : {}),
    'claude-resume': () => core.resumeClaudeInTerminal(args.name),
    'open-vscode': () => { execFileSync('open', ['-a', 'Visual Studio Code', args.path]); return { path: args.path } },
    // Only claude:// links: a new Desktop session in a folder, or a session's own link.
    'open-claude-link': () => {
      // No regex here: this script is a template literal, where a \\/ escape collapses to / and starts a comment.
      if (!String(args.url).startsWith('claude://')) throw new Error('not a claude:// link: ' + args.url)
      execFileSync('open', [args.url])
      return { url: args.url }
    },
    'form-schema': async () => ({ bundle: await core.getFormSchema(), trackerLabel: tracker.label }),
    'issue-form-request': () => core.buildIssueFormRequest(args.ref),
    'issue-form-apply': () => core.applyIssueFormAnswer(args.base, args.answer),
    // open: false: the pane opens a Desktop session in the new folder instead of VS Code.
    'tracker-auth': () => tracker.checkAuth(),
    // The pane distils on the session's own model (fetchIssue) before Create and sends distill: false.
    'create-workspace': () => core.createWorkspace(args.formData, { open: false, distill: args.distill }),
    'refine-request': () => core.buildRefinePrompt(args.text, args.instruction, args.formData),
    // The create form's rules live in sandbox-core, shared with the browser form.
    'validate-form': () => core.validateFormData(args.bundle, args.formData),
    'merge-form': () => core.mergeFormData(args.current, args.incoming),
  }
  if (!ops[op]) throw new Error('unknown op ' + op)
  out({ ok: true, result: await ops[op]() })
} catch (e) {
  out({ ok: false, error: (e && e.message) || String(e) })
}
`;

/** One sandbox-core call in a node child; throws with the child's error text. */
async function core<T>(
  $: EngineInterface,
  op: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<T> {
  const r = await $.process.run(["node", "--input-type=module", "-e", SCRIPT], {
    stdin: JSON.stringify({ op, ...args }),
    timeoutMs,
  });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  let o: { ok: boolean; result?: T; error?: string };
  try {
    o = JSON.parse(line);
  } catch {
    // The first error line names the failure; node's last stderr line is often only its version banner.
    const lines = r.stderr.trim().split("\n");
    throw new Error(
      lines.find((l) => /Error\b/.test(l)) ||
        lines.pop() ||
        `sandbox-core gave no result (exit ${r.exitCode})`,
    );
  }
  if (!o.ok || o.result === undefined) throw new Error(o.error ?? "sandbox-core failed");
  return o.result;
}
export const POLL_MS = 5000;
/** PRs refresh this often: each workspace × repo is a `gh` network call. */
export const PR_POLL_MS = 60000;
/** PR callbacks (#236): every desktop session runs a pass this often; the core's lock lets one through. */
export const CALLBACK_POLL_MS = 600000;

const ROWS = { plugin: "werkmeister", key: "rows" } as const;
const ERROR = { plugin: "werkmeister", key: "error" } as const;
const BUSY = { plugin: "werkmeister", key: "busy" } as const;
const CONFIRM = { plugin: "werkmeister", key: "confirmEnd" } as const;
const REASON = { plugin: "werkmeister", key: "abandonReason" } as const;
const NOTE = { plugin: "werkmeister", key: "note" } as const;
const TAB = { plugin: "werkmeister", key: "tab" } as const;
const FOCUS = { plugin: "werkmeister", key: "focus" } as const;
const TRACKER = { plugin: "werkmeister", key: "tracker" } as const;
export const TRACKER_TTL_MS = 5 * 60 * 1000;
let trackerAt = 0;
const INFRA = { plugin: "werkmeister", key: "infra" } as const;
const INTERCEPTS = { plugin: "werkmeister", key: "intercepts" } as const;
/** CONFIRM prefix for a pending intercept ON: `intercept:<workspace>/<service>`. */
const INTERCEPT = "intercept:";
const PRS = { plugin: "werkmeister", key: "prs" } as const;
/** BUSY while `sandbox connect` runs; no workspace name has parentheses. */
const CONNECTING = "(connect)";

const FORM = { plugin: "werkmeister", key: "formSchema" } as const;
const DRAFT = { plugin: "werkmeister", key: "draft" } as const;
const FORM_BUSY = { plugin: "werkmeister", key: "formBusy" } as const;
const FOCUSED = { plugin: "werkmeister", key: "focusedField" } as const;

/** Mobile draws no Input or Select, so there the Create tab hands the form to the model instead. */
export function createPrompt(issueId: string): string {
  const id = issueId.trim();
  return `Create a new sandbox workspace with the werkmeister:workspace skill${id ? `, pre-filled from issue ${id}` : ""}.`;
}

/**
 * The create form's fields from the same RJSF bundle the browser form renders
 * (getFormSchema: the terminal wizard's prompts), in its `ui:order`. An array
 * with choices is a multi-pick; a string with choices a select; a boolean a
 * checkbox; a `textarea` widget a multi-line field; the rest one line. Titles lose the wizard's
 * terminal hints, `(blank to skip)` and the like: the form marks required
 * fields itself and the description says the rest.
 */
export function formFields(bundle: FormBundle): FormField[] {
  const props = bundle.schema.properties ?? {};
  const order = (bundle.uiSchema["ui:order"] as string[] | undefined) ?? Object.keys(props);
  const required = new Set(bundle.schema.required ?? []);
  return order.flatMap((k) => {
    const p = props[k];
    if (!p) return [];
    const ui = (bundle.uiSchema[k] ?? {}) as Record<string, unknown>;
    const options = (p.type === "array" ? p.items?.enum : p.enum) ?? [];
    return {
      key: k,
      title: (p.title ?? k).replace(/\s*\([^)]*\)\s*$/, ""),
      help: p.description ?? "",
      kind:
        p.type === "boolean"
          ? "check"
          : options.length
            ? p.type === "array"
              ? "multi"
              : "select"
            : ui["ui:widget"] === "textarea"
              ? "textarea"
              : "text",
      options,
      groups: ((ui["ui:options"] ?? {}) as { groups?: Record<string, string[]> }).groups ?? {},
      refine: refineOf(ui),
      required: required.has(k),
      pattern: p.pattern ?? null,
      placeholder: typeof ui["ui:placeholder"] === "string" ? ui["ui:placeholder"] : "",
    } satisfies FormField;
  });
}

/** A refinable field's instruction for refinePrompt ("" = its default), or null when the field isn't refinable. */
function refineOf(ui: Record<string, unknown>): string | null {
  const o = (ui["ui:options"] ?? {}) as { refinable?: boolean; refineInstruction?: string };
  return o.refinable ? (o.refineInstruction ?? "") : null;
}

/** A multi-pick draws as checkboxes in this many columns, as the browser form does. */
const COLUMNS = 5;

/** [heading, options] in schema order: the bundle's groups (an option in none goes under "other"), else one unheaded group. */
export function optionGroups(f: FormField): [string, string[]][] {
  const headings = Object.keys(f.groups);
  if (!headings.length) return [["", f.options]];
  const grouped = new Set(Object.values(f.groups).flat());
  const out: [string, string[]][] = headings
    .sort()
    .map((h) => [h, f.options.filter((o) => (f.groups[h] ?? []).includes(o))]);
  const rest = f.options.filter((o) => !grouped.has(o));
  if (rest.length) out.push(["other", rest]);
  return out.filter(([, opts]) => opts.length > 0);
}

const isEmpty = (v: Draft[string] | undefined) =>
  v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Why the draft can't be submitted, one line per field in form order; [] when it can. The rules are sandbox-core's validateFormData. */
async function formErrors(
  $: EngineInterface,
  bundle: FormBundle,
  fields: FormField[],
  draft: Draft,
): Promise<string[]> {
  const errors = await core<Record<string, string>>($, "validate-form", {
    bundle: { schema: bundle.schema },
    formData: draft,
  });
  const known = fields.filter((f) => errors[f.key]).map((f) => `${f.title}: ${errors[f.key]}`);
  return [
    ...known,
    ...Object.entries(errors)
      .filter(([k]) => !fields.some((f) => f.key === k))
      .map(([, message]) => message),
  ];
}

/**
 * Values from the workspace_form tool laid over the draft: a key the form doesn't
 * have, a choice it doesn't offer or a value of the wrong shape is left out and
 * named in `problems`. "" or [] clears a field; a multi-pick also takes "a, b".
 */
export function applyFormFields(
  fields: FormField[],
  draft: Draft,
  input: Record<string, unknown>,
): { draft: Draft; problems: string[] } {
  const out = { ...draft };
  const problems: string[] = [];
  for (const [k, raw] of Object.entries(input)) {
    const f = fields.find((x) => x.key === k);
    if (!f) {
      problems.push(`${k}: no such field (fields: ${fields.map((x) => x.key).join(", ")})`);
      continue;
    }
    if (f.kind === "check") {
      // The tool's input schema carries strings, so "true" / "false" arrive as text.
      const on =
        raw === true || raw === "true"
          ? true
          : raw === false || raw === "false" || raw === ""
            ? false
            : null;
      if (on === null) problems.push(`${k}: expected true or false`);
      else out[k] = on;
      continue;
    }
    if (f.kind === "multi") {
      const list =
        typeof raw === "string"
          ? raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : raw;
      if (!Array.isArray(list) || !list.every((v) => typeof v === "string")) {
        problems.push(`${k}: expected a list of choices`);
        continue;
      }
      const bad = list.filter((v) => !f.options.includes(v));
      if (bad.length)
        problems.push(`${k}: not offered: ${bad.join(", ")} (choices: ${f.options.join(", ")})`);
      out[k] = list.filter((v) => f.options.includes(v));
      continue;
    }
    if (typeof raw !== "string") {
      problems.push(`${k}: expected text`);
      continue;
    }
    if (f.kind === "select" && raw !== "" && !f.options.includes(raw)) {
      problems.push(`${k}: "${raw}" is not offered (choices: ${f.options.join(", ")})`);
      continue;
    }
    out[k] = raw;
  }
  return { draft: out, problems };
}

const FORM_TOOL = "workspace_form";

/** The workspace_form tool: fill the Create tab from the prompt, then the person reviews and creates. */
async function fillFormTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  await openPane($);
  await openCreate($);
  const { value: form = null } = await $.state.get(FORM);
  if (!form) {
    const { value: note = "" } = await $.state.get(NOTE);
    return note || "Couldn't load the workspace form.";
  }
  const fields = formFields(form.bundle);
  const { value: draft = {} } = await $.state.get(DRAFT);
  const given =
    input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
      ? (input.fields as Record<string, unknown>)
      : {};
  const r = applyFormFields(fields, draft, given);
  await $.state.set(DRAFT, r.draft);
  const missing = await formErrors($, form.bundle, fields, r.draft);
  return [
    `The Create tab of the /workspaces pane now holds:`,
    JSON.stringify(r.draft, null, 2),
    r.problems.length ? `Left out:\n- ${r.problems.join("\n- ")}` : "",
    missing.length
      ? `Still needed before Create:\n- ${missing.join("\n- ")}`
      : "Ready: the person presses ＋ Create workspace in the pane to create it.",
    "This tool never creates the workspace.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function openCreate($: EngineInterface): Promise<void> {
  await $.state.set(TAB, "create");
  const { value: form = null } = await $.state.get(FORM);
  if (form) return;
  try {
    const r = await core<{ bundle: FormBundle; trackerLabel: string }>($, "form-schema");
    await $.state.set(FORM, { bundle: r.bundle, trackerLabel: r.trackerLabel });
    await $.state.set(DRAFT, r.bundle.formData ?? {});
  } catch (err) {
    await $.state.set(NOTE, `Couldn't load the workspace form: ${(err as Error).message}`);
  }
}

async function setField($: EngineInterface, key: string, value: Draft[string]): Promise<void> {
  const { value: draft = {} } = await $.state.get(DRAFT);
  await $.state.set(DRAFT, { ...draft, [key]: value });
}

async function fetchIssue($: EngineInterface): Promise<void> {
  const { value: draft = {} } = await $.state.get(DRAFT);
  const ref = typeof draft.issue_id === "string" ? draft.issue_id.trim() : "";
  if (!ref) return;
  await $.state.set(FORM_BUSY, "fetch");
  try {
    // The tracker lookup runs in sandbox-core; the distillation runs on this session's own client and login.
    const req = await core<{ base: Record<string, unknown>; prompt: string | null }>(
      $,
      "issue-form-request",
      { ref },
      180000,
    );
    if (!req.base.issue_id) {
      await $.state.set(NOTE, `Couldn't read an issue from "${ref}".`);
      return;
    }
    let data = req.base;
    let failed = "";
    if (req.prompt) {
      const r = await $.model.complete({ model: REFINE_MODEL, prompt: req.prompt });
      if (r.isAnswered)
        data = await core<Record<string, unknown>>($, "issue-form-apply", {
          base: req.base,
          answer: r.text,
        });
      else failed = ` Couldn't distil the rest (${r.reason}).`;
    }
    const { value: now = {} } = await $.state.get(DRAFT);
    const merged = await core<Draft>($, "merge-form", { current: now, incoming: data });
    const filled = Object.keys(data).filter(
      (k) => k !== "issue_id" && isEmpty(now[k]) && !isEmpty(merged[k]),
    );
    await $.state.set(DRAFT, merged);
    await $.state.set(
      NOTE,
      (filled.length
        ? `Filled ${filled.join(", ")} from ${data.issue_id}.`
        : `${data.issue_id}: nothing new to fill.`) + failed,
    );
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message);
  } finally {
    await $.state.set(FORM_BUSY, "");
  }
}

/** The model behind Refine with Claude and the issue fetch's distillation. */
export const REFINE_MODEL = "sonnet";

/**
 * "Refine with Claude": rewrite the field with sandbox-core's refine prompt, the issue and the other fields as context.
 * The completion runs on this session's own client and login, not a `claude -p` child with credentials of its own.
 */
async function refineField($: EngineInterface, key: string, instruction: string): Promise<void> {
  const { value: draft = {} } = await $.state.get(DRAFT);
  const text = typeof draft[key] === "string" ? draft[key].trim() : "";
  if (!text) {
    await $.state.set(NOTE, "Write something first; Refine rewrites what is there.");
    return;
  }
  await $.state.set(FORM_BUSY, "refine");
  try {
    const formData = Object.fromEntries(Object.entries(draft).filter(([, v]) => !isEmpty(v)));
    const prompt = await core<string>($, "refine-request", { text, instruction, formData });
    const r = await $.model.complete({ model: REFINE_MODEL, prompt });
    if (!r.isAnswered) {
      await $.state.set(NOTE, `Refine failed (${r.reason}); the field is unchanged.`);
      return;
    }
    // Same extraction as sandbox-core's extractResult.
    const refined = (r.text.match(/<result>\s*([\s\S]*?)\s*<\/result>/i)?.[1] ?? r.text).trim();
    if (!refined) {
      await $.state.set(NOTE, "Refine returned no text; the field is unchanged.");
      return;
    }
    await setField($, key, refined);
    await $.state.set(NOTE, "Refined. Edit it, or Refine again.");
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message);
  } finally {
    await $.state.set(FORM_BUSY, "");
  }
}

async function submitForm($: EngineInterface): Promise<void> {
  const { value: form = null } = await $.state.get(FORM);
  const { value: first = {} } = await $.state.get(DRAFT);
  if (!form) return;
  // Core stores the issue but doesn't run a model for the pane: fill empty fields on the session model first.
  if (
    typeof first.issue_id === "string" &&
    first.issue_id.trim() &&
    (isEmpty(first.description) || isEmpty(first.starting_prompt))
  ) {
    await fetchIssue($);
    // What the model filled is a default to review, not something to create from unseen.
    const { value: filled = {} } = await $.state.get(DRAFT);
    // The ref's own normalisation (api#7 → acme/api#7) is not a fill.
    if (
      Object.keys(filled).some(
        (k) => k !== "issue_id" && JSON.stringify(filled[k]) !== JSON.stringify(first[k]),
      )
    ) {
      const { value: note = "" } = await $.state.get(NOTE);
      await $.state.set(NOTE, `${note} Review, then press Create again.`);
      return;
    }
  }
  const { value: draft = {} } = await $.state.get(DRAFT);
  const errors = await formErrors($, form.bundle, formFields(form.bundle), draft);
  if (errors.length) {
    await $.state.set(NOTE, errors.join("\n"));
    return;
  }
  const formData = Object.fromEntries(Object.entries(draft).filter(([, v]) => !isEmpty(v)));
  await $.state.set(FORM_BUSY, "create");
  await $.state.set(NOTE, "Creating the workspace…");
  try {
    const r = await core<{ command: string; workspacePath: string | null }>(
      $,
      "create-workspace",
      { formData, distill: false },
      600000,
    );
    await $.state.set(DRAFT, {});
    await $.state.set(TAB, "list");
    await $.state.set(NOTE, `Created ${r.workspacePath ?? r.command}`);
    // A failed open must not read as a failed create: the workspace exists either way.
    const opened =
      r.workspacePath !== null &&
      (await core($, "open-claude-link", { url: newSessionLink(r.workspacePath) }).then(
        () => true,
        () => false,
      ));
    $.ui.toast(
      opened
        ? "Workspace created; opening a new session in it"
        : "Workspace created; open it with ＋ New session",
    );
  } catch (err) {
    // The transcript can run long; its last lines carry the failure.
    await $.state.set(NOTE, (err as Error).message.split("\n").slice(-6).join("\n"));
  } finally {
    await $.state.set(FORM_BUSY, "");
  }
  await tick($);
}

type ListEntry = Pick<
  WorkspaceRow,
  | "name"
  | "path"
  | "issueId"
  | "issueUrl"
  | "labels"
  | "task"
  | "description"
  | "workType"
  | "stage"
  | "lifecycle"
  | "sessionTitle"
  | "sessionOrigin"
  | "feature"
>;
type ListResult = { workspaces: ListEntry[] };
type StatusResult = {
  infra?: InfraStatus;
  statuses: {
    name: string;
    state: WorkspaceRow["state"];
    running: number;
    total: number;
    services: ServiceHealth[];
    claude: { state: string; waiting: boolean };
  }[];
};
type SessionInfo = {
  sessionId: string;
  title: string;
  cwd: string;
  link?: string;
  startedBy?: string;
  pinned?: boolean;
};
type ToolResult = {
  content: { type: string; text?: string }[];
  isError: boolean;
  structuredContent?: unknown;
};

/** The tool's structured result, or its first text block parsed as JSON (ccd tools return JSON text). */
function payload<T>(r: ToolResult): T {
  if (r.isError)
    throw new Error(
      r.content
        .map((c) => c.text ?? "")
        .join(" ")
        .trim() || "tool failed",
    );
  if (r.structuredContent !== undefined) return r.structuredContent as T;
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as T;
}

/** True when `child` is `parent` or inside it, by path segment: /ws/ab is not an ancestor of /ws/abc. */
function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

/** The newest session whose cwd lies in `path`, and in no deeper workspace. Sessions arrive newest first. */
export function sessionFor(
  path: string,
  allPaths: string[],
  sessions: SessionInfo[],
): WorkspaceRow["session"] {
  // list_sessions leaves out the calling session, so a startedBy naming no listed session is this one.
  // ponytail: a starter archived or past the list limit reads as this session too; the split then refuses and says so.
  const listed = new Set(sessions.map((s) => s.sessionId));
  for (const s of sessions) {
    if (!contains(path, s.cwd)) continue;
    const deeper = allPaths.some(
      (p) => p !== path && p.length > path.length && contains(path, p) && contains(p, s.cwd),
    );
    if (deeper) continue;
    return {
      id: s.sessionId,
      title: s.title,
      link: s.link ?? null,
      beside: !!s.startedBy && !listed.has(s.startedBy),
      pinned: s.pinned === true,
    };
  }
  return null;
}

export function buildRows(
  list: ListResult,
  status: StatusResult,
  sessions: SessionInfo[],
): WorkspaceRow[] {
  const byName = new Map(status.statuses.map((s) => [s.name, s]));
  const allPaths = list.workspaces.map((w) => w.path);
  return list.workspaces.map((w) => {
    const s = byName.get(w.name);
    return {
      ...w,
      state: s?.state ?? "unknown",
      running: s?.running ?? 0,
      total: s?.total ?? 0,
      services: s?.services ?? [],
      claude: s?.claude.state === "running" ? "working" : s?.claude.waiting ? "waiting" : null,
      session: sessionFor(w.path, allPaths, sessions),
    };
  });
}

/** With the toggle on, only workspaces labelled `focus` (in `.sandbox/workspace.yml`) are listed. */
export function visibleRows(rows: WorkspaceRow[], focus: boolean): WorkspaceRow[] {
  return focus ? rows.filter((r) => r.labels.includes("focus")) : rows;
}

/** The card border carries the state; nothing else in the card repeats it. */
const BORDER: Record<WorkspaceRow["state"], "success" | "warning" | "inactive"> = {
  up: "success",
  partial: "warning",
  stopped: "inactive",
  down: "inactive",
  unknown: "warning",
};

/** Past `working`, the lifecycle says more than the stage does (every stage has output by then). */
export function lifecycleLabel(r: WorkspaceRow): string | null {
  const l = r.lifecycle;
  if (!l || l.state === "working") return null;
  if (l.state === "pr-open")
    return `PR open (${l.prs.filter((p) => p.status === "open").length}/${l.prs.length})`;
  return {
    ready: "ready to open",
    merged: "merged — awaiting release",
    shipped: "shipped — close out",
    "closed-out": "closed out",
    abandoned: "abandoned",
  }[l.state];
}

/** The card's detail line: work type (when no issue line carries it), lifecycle or ICM stage, running/total; '' when none. */
export function cardMeta(r: WorkspaceRow): string {
  return [
    r.issueId ? null : r.workType,
    lifecycleLabel(r) ??
      (r.stage ? `stage ${r.stage.index}/${r.stage.total} ${r.stage.name}` : null),
    r.total > 0 ? `${r.running}/${r.total}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The Claude flag at the header's right edge: waiting on you is the one thing a glance must catch. */
const CLAUDE: Record<
  NonNullable<WorkspaceRow["claude"]>,
  { text: string; color: "warning" | "claude" }
> = {
  waiting: { text: "● waiting for you", color: "warning" },
  working: { text: "◌ working", color: "claude" },
};

/** The session line's title: the desktop session in the folder, else the newest on-disk session. */
export function sessionTitle(r: WorkspaceRow): string | null {
  return r.session?.title ?? r.sessionTitle;
}

/** Where the session shown started: Desktop, VS Code, or CLI. */
export function sessionOrigin(r: WorkspaceRow): "Desktop" | "VS Code" | "CLI" | null {
  if (r.session) return "Desktop";
  if (r.sessionOrigin === null) return null;
  return r.sessionOrigin === "claude-vscode"
    ? "VS Code"
    : r.sessionOrigin === "claude-desktop"
      ? "Desktop"
      : "CLI";
}

/**
 * Where Continue picks the session up, named on its button: Desktop when the app lists it
 * (the pane focuses or opens it), VS Code for a VS Code session (the folder opens there),
 * else a Terminal window running `claude --resume`.
 */
export function continueTarget(r: WorkspaceRow): "Desktop" | "VS Code" | "Terminal" {
  if (r.session) return "Desktop";
  return r.sessionOrigin === "claude-vscode" ? "VS Code" : "Terminal";
}

/** `claude://code/new?folder=…`: the link the app's "New Claude Code Session Here" Finder service opens. */
export function newSessionLink(path: string): string {
  return `claude://code/new?folder=${encodeURIComponent(path)}&source=services`;
}

/** The session line: `session · VS Code · title`. */
export function sessionLine(r: WorkspaceRow): string | null {
  const title = sessionTitle(r);
  return title ? ["session", sessionOrigin(r), title].filter(Boolean).join(" · ") : null;
}

/** The infra line: `infra · partial · 4/5 · down: caddy`; services not healthy or running are named. */
export function infraLine(
  i: InfraStatus | null,
  t: { ok: boolean; reason?: string; fix: string } | null = null,
): string {
  const tracker = t && !t.ok ? `tracker: ${t.reason} · ${t.fix}` : null;
  if (!i) return ["infra · unknown", tracker].filter(Boolean).join(" · ");
  const bad = i.services
    .filter((s) => s.state !== "healthy" && s.state !== "running")
    .map((s) => `${s.state}: ${s.name}`);
  return ["infra", i.state, i.total > 0 ? `${i.running}/${i.total}` : null, ...bad, tracker]
    .filter(Boolean)
    .join(" · ");
}

/** The issue line's prefix: the work type, as the issue's kind. */
export function issueKind(r: WorkspaceRow): string {
  return r.workType ?? "issue";
}

/** The PRs worth a link: those that exist. Label `org/repo#N`, as GitHub refs are written, from the PR URL. */
export function prLinks(
  prs: RepoPr[],
): { key: string; href: string; label: string; state: RepoPr["state"] }[] {
  return prs.flatMap((p) => {
    if (!p.url) return [];
    const m = p.url.match(/^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    return [
      {
        key: p.url,
        href: p.url,
        label: m ? `${m[1]}#${m[2]}` : `${p.repo}#${p.url.split("/").pop()}`,
        state: p.state,
      },
    ];
  });
}

/** GitHub's state colours for the merge icon and state after the link: green open, purple merged, red closed. */
const PR_COLOR: Record<NonNullable<RepoPr["state"]>, "success" | "merged" | "error"> = {
  OPEN: "success",
  MERGED: "merged",
  CLOSED: "error",
};

const INFRA_COLOR: Record<InfraStatus["state"], "success" | "warning" | "error"> = {
  up: "success",
  partial: "warning",
  down: "error",
  unknown: "warning",
};

/** `sandbox connect`: brings up the shared infra, then refreshes so the infra line shows the result. */
async function connect($: EngineInterface): Promise<void> {
  const { value: busy = "" } = await $.state.get(BUSY);
  if (busy !== "") return;
  await $.state.set(BUSY, CONNECTING);
  await $.state.set(NOTE, "sandbox connect…");
  try {
    const r = await core<{ ok: boolean }>($, "connect", {}, 600000);
    await $.state.set(
      NOTE,
      r.ok
        ? "sandbox connect: done"
        : "sandbox connect: some infra failed to start; check docker and your kubeconfig",
    );
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message);
  } finally {
    await $.state.set(BUSY, "");
  }
  await tick($);
}

let ticking = false;
/** Refreshes rows once. A tick that starts while one runs is skipped. */
async function tick($: EngineInterface): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // Kept out of the Promise.all: a failed or slow telepresence read must never cost the rows.
    const intercepts = core<InterceptsSnapshot>($, "intercepts", {}, 20000).catch(() => null);
    const [list, status, sessionsR] = await Promise.all([
      core<ListResult>($, "list-workspaces"),
      core<StatusResult>($, "workspace-status"),
      $.mcp.call("ccd_session_mgmt", "list_sessions", { limit: 50 }).catch(() => null),
    ]);
    let sessions: SessionInfo[] = [];
    try {
      sessions = sessionsR ? payload<SessionInfo[]>(sessionsR) : [];
    } catch {
      sessions = [];
    }
    await $.state.set(ROWS, buildRows(list, status, sessions));
    await $.state.set(INFRA, status.infra ?? null);
    await $.state.set(INTERCEPTS, await intercepts);
    await $.state.set(ERROR, "");
    if (Date.now() - trackerAt > TRACKER_TTL_MS) {
      trackerAt = Date.now();
      // Not awaited: a slow tracker check must not hold up row polling.
      void core<{ ok: boolean; reason?: string; fix: string }>($, "tracker-auth").then(
        (a) => $.state.set(TRACKER, a),
        () => $.state.set(TRACKER, null),
      );
    }
  } catch (err) {
    await $.state.set(ERROR, (err as Error).message);
  } finally {
    ticking = false;
  }
}

export type InterceptControl = {
  kind: "off" | "active" | "other" | "blocked" | "unavailable";
  text: string;
};

/** One service's toggle. The VS Code tree's `interceptView` rules; this standalone plugin can't import it. */
export function interceptControl(
  row: InterceptRow | undefined,
  feature: string | null,
  snap: InterceptsSnapshot | null,
): InterceptControl {
  if (snap === null) return { kind: "unavailable", text: "intercept state unavailable" };
  if (!snap.available) return { kind: "unavailable", text: "intercepts unavailable" };
  if (!row) return { kind: "blocked", text: "not an interceptable service of this workspace" };
  if (row.intercepted) {
    // One intercept per deployment: an unreadable owner is never offered a Leave.
    if (feature !== null && row.intercepted_by === feature)
      return { kind: "active", text: "⇄ Intercepted" };
    return {
      kind: "other",
      text:
        row.intercepted_by === null
          ? "⇄ intercepted (owner unknown)"
          : `⇄ intercepted by '${row.intercepted_by}'`,
    };
  }
  if (!row.interceptable)
    return { kind: "blocked", text: `not interceptable: ${row.blocker ?? "unknown reason"}` };
  return { kind: "off", text: "" };
}

/** Intercept buttons. ON asks first, as it installs a traffic-agent sidecar on a shared dev cluster; OFF runs at once. */
async function pressIntercept(
  $: EngineInterface,
  kind: "ask" | "yes" | "cancel" | "leave",
  name: string,
  service: string,
): Promise<void> {
  const { value: busy = "" } = await $.state.get(BUSY);
  if (busy !== "") return;
  if (kind === "ask") {
    await $.state.set(CONFIRM, `${INTERCEPT}${name}/${service}`);
    return;
  }
  await $.state.set(CONFIRM, "");
  if (kind === "cancel") return;
  const { value: rows = [] } = await $.state.get(ROWS);
  const feature = rows.find((r) => r.name === name)?.feature;
  if (!feature) return;
  await $.state.set(BUSY, name);
  await $.state.set(NOTE, `${service}: ${kind === "yes" ? "starting" : "leaving"} intercept…`);
  try {
    if (kind === "yes") {
      await core($, "intercept-start", { name, feature, service }, 180000);
      await $.state.set(NOTE, `${service}: intercepted (x-feature: ${feature})`);
    } else {
      await core($, "intercept-leave", { name, feature, service }, 60000);
      await $.state.set(NOTE, `${service}: left intercept`);
    }
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message);
  } finally {
    await $.state.set(BUSY, "");
  }
  await tick($);
}

const SERVICE_COLOR: Record<ServiceHealth["state"], "success" | "warning" | "error" | undefined> = {
  healthy: "success",
  starting: "warning",
  running: undefined,
  down: "error",
};

export type Action =
  | "up"
  | "stop"
  | "restart"
  | "down"
  | "new"
  | "continue"
  | "beside"
  | "pin"
  | "prs"
  | "closeout"
  | "abandon";
type Lifecycle = "up" | "stop" | "restart" | "down";
const LIFECYCLE = new Set<Action>(["up", "stop", "restart", "down"]);

/** Mirrors the VS Code extension's `view/item/context` when-clauses. */
export function buttonsFor(state: WorkspaceRow["state"]): Action[] {
  const out: Action[] = [];
  if (state === "down" || state === "stopped" || state === "partial") out.push("up");
  if (state === "up" || state === "partial") out.push("stop");
  out.push("restart", "down", "new");
  return out;
}

const LABEL: Record<Exclude<Action, "continue" | "pin">, string> = {
  up: "▶ Up",
  stop: "■ Stop",
  restart: "↻ Restart",
  down: "⏻ Down",
  new: "＋ New session",
  beside: "⇆ Open beside",
  prs: "↻ PRs",
  closeout: "✓ Close out",
  abandon: "✕ Abandon…",
};

/** The lifecycle buttons a row offers: refresh PR state while one is in flight. */
export function lifecycleButtonsFor(r: WorkspaceRow): "prs"[] {
  const s = r.lifecycle?.state;
  return s === "pr-open" || s === "merged" ? ["prs"] : [];
}

/**
 * The card's one end-of-workspace button (#160): Close out once every PR settled (or a spike with none, or a
 * retry after a failed removal), else Abandon, which needs a typed reason, so none where no Input draws.
 */
export function endActionFor(r: WorkspaceRow, canType: boolean): "closeout" | "abandon" | null {
  const s = r.lifecycle?.state;
  if (
    s === "shipped" ||
    s === "abandoned" ||
    s === "closed-out" ||
    (r.workType === "spike" && !r.lifecycle?.prs.length)
  )
    return "closeout";
  return canType ? "abandon" : null;
}

/** CONFIRM holds `close-out:<name>` or `abandon:<name>` between the two presses. */
const CLOSE_OUT = "close-out:";
const ABANDON = "abandon:";

/**
 * Archives every desktop session whose cwd is in `path`, one line each. A refusal (a pinned or on-screen
 * session, a declined approval) is reported, never fatal: the workspace is already gone. list_sessions
 * leaves out the calling session, so it is never archived from under itself.
 */
export async function archiveSessions($: EngineInterface, path: string): Promise<string[]> {
  let sessions: SessionInfo[];
  try {
    sessions = payload<SessionInfo[]>(
      await $.mcp.call("ccd_session_mgmt", "list_sessions", { limit: 200 }),
    );
  } catch (err) {
    return [`desktop sessions not archived: ${(err as Error).message}`];
  }
  const out: string[] = [];
  for (const s of sessions.filter((x) => contains(path, x.cwd))) {
    try {
      const r = await $.mcp.call("ccd_session_mgmt", "archive_session", {
        session_id: s.sessionId,
      });
      out.push(
        r.isError
          ? `left open "${s.title}": ${r.content
              .map((c) => c.text ?? "")
              .join(" ")
              .trim()}`
          : `archived "${s.title}"`,
      );
    } catch (err) {
      out.push(`left open "${s.title}": ${(err as Error).message}`);
    }
  }
  return out;
}

async function runAction(
  $: EngineInterface,
  name: string,
  action: Lifecycle | "prs" | "closeout" | "abandon",
): Promise<void> {
  await $.state.set(BUSY, name);
  await $.state.set(NOTE, `${name}: ${action}…`);
  try {
    const { value: rows = [] } = await $.state.get(ROWS);
    const path = rows.find((x) => x.name === name)?.path;
    if (action === "closeout" || action === "abandon") {
      const { value: reason = "" } = await $.state.get(REASON);
      const r = await core<{ command: string; terminals?: string[] }>(
        $,
        "close-out",
        action === "abandon" ? { name, abandon: reason } : { name },
        600000,
      );
      const archived = path ? await archiveSessions($, path) : [];
      await $.state.set(
        NOTE,
        [r.command.split("\n")[0]?.trim() || "done", ...archived, ...(r.terminals ?? [])].join(
          "\n",
        ),
      );
      await $.state.set(REASON, "");
    } else {
      const r =
        action === "prs"
          ? await core<{ command: string }>($, "pr-status", { path }, 120000)
          : await core<{ command: string; output: string }>(
              $,
              "workspace-action",
              { name, action },
              600000,
            );
      await $.state.set(NOTE, r.command.split("\n")[0]?.trim() || "done");
    }
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message);
  } finally {
    await $.state.set(BUSY, "");
  }
  await tick($);
}

/** Every row button lands here. A press while any action runs is ignored, never queued. */
async function press($: EngineInterface, action: Action, name: string): Promise<void> {
  const { value: busy = "" } = await $.state.get(BUSY);
  if (busy !== "") return;

  const { value: pending = "" } = await $.state.get(CONFIRM);
  if (pending !== "" && pending !== CLOSE_OUT + name && pending !== ABANDON + name) {
    await $.state.set(CONFIRM, "");
    await $.state.set(REASON, "");
  }

  if (action === "new") {
    const { value: rows = [] } = await $.state.get(ROWS);
    const row = rows.find((r) => r.name === name);
    if (!row) return;
    try {
      await core($, "open-claude-link", { url: newSessionLink(row.path) });
      $.ui.toast(
        `Opening a new session in ${name}. To keep this pane in sight: right-click it in the sidebar → Open in → Split view`,
      );
    } catch (err) {
      await $.state.set(NOTE, (err as Error).message);
    }
    return;
  }

  // A claude:// Link draws nothing on the desktop pane (probe, 2026-10-09), so the button focuses the session,
  // else opens its link through the node child.
  // Beside: the session in split view next to this one, so the pane stays in sight. The button shows only
  // for sessions this one started, the only ones the app will split.
  if (action === "beside") {
    const { value: rows = [] } = await $.state.get(ROWS);
    const row = rows.find((r) => r.name === name);
    if (!row?.session?.beside) return;
    const r = await $.mcp.call("ccd_window", "open_session_in", {
      session_id: row.session.id,
      target: "split",
    });
    if (r.isError)
      await $.state.set(
        NOTE,
        r.content
          .map((c) => c.text ?? "")
          .join(" ")
          .trim(),
      );
    return;
  }

  // Pin: the session's sidebar pin, through the desktop's ccd_sidebar server (absent outside the desktop).
  if (action === "pin") {
    const { value: rows = [] } = await $.state.get(ROWS);
    const row = rows.find((r) => r.name === name);
    if (!row?.session) return;
    try {
      const r = await $.mcp.call("ccd_sidebar", "set_pinned", {
        session_id: row.session.id,
        pinned: !row.session.pinned,
      });
      if (r.isError)
        await $.state.set(
          NOTE,
          r.content
            .map((c) => c.text ?? "")
            .join(" ")
            .trim(),
        );
    } catch (err) {
      await $.state.set(NOTE, (err as Error).message);
    }
    await tick($);
    return;
  }

  if (action === "continue") {
    const { value: rows = [] } = await $.state.get(ROWS);
    const row = rows.find((r) => r.name === name);
    if (!row) return;
    try {
      if (row.session) {
        const r = await $.mcp.call("ccd_window", "open_session_in", {
          session_id: row.session.id,
          target: "focus",
        });
        if (!r.isError) return;
        // open_session_in focuses only sessions this one started; the session's own link opens any.
        if (row.session.link) await core($, "open-claude-link", { url: row.session.link });
        else $.ui.toast(`Open "${row.session.title}" from the sidebar`);
        return;
      }
      if (continueTarget(row) === "VS Code") {
        await core($, "open-vscode", { path: row.path });
        $.ui.toast(`Opening ${name} in VS Code`);
        return;
      }
      await core($, "claude-resume", { name });
      $.ui.toast(`Resuming "${row.sessionTitle ?? name}" in a Terminal window`);
    } catch (err) {
      await $.state.set(NOTE, (err as Error).message);
    }
    return;
  }

  if (action === "abandon") {
    if (pending !== ABANDON + name) {
      await $.state.set(CONFIRM, ABANDON + name);
      await $.state.set(REASON, "");
      return;
    }
    const { value: reason = "" } = await $.state.get(REASON);
    if (!reason.trim()) {
      await $.state.set(NOTE, "Give a reason to abandon");
      return;
    }
    await $.state.set(CONFIRM, "");
    await runAction($, name, "abandon");
    return;
  }

  if (action === "closeout") {
    if (pending !== CLOSE_OUT + name) {
      await $.state.set(CONFIRM, CLOSE_OUT + name);
      return;
    }
    await $.state.set(CONFIRM, "");
    await runAction($, name, "closeout");
    return;
  }

  if (action === "prs") {
    await runAction($, name, "prs");
    return;
  }

  if (LIFECYCLE.has(action)) await runAction($, name, action as Lifecycle);
}

let prTicking = false;
/** Refreshes PRs once; a failure keeps the last ones shown. */
async function prTick($: EngineInterface): Promise<void> {
  if (prTicking) return;
  prTicking = true;
  try {
    const r = await core<{ name: string; repos: RepoPr[] }[]>($, "workspace-prs", {}, 120000);
    await $.state.set(PRS, Object.fromEntries(r.map((w) => [w.name, w.repos])));
  } catch {
    // gh missing or offline: keep what's shown.
  } finally {
    prTicking = false;
  }
}

let timers: { cancel: () => void }[] = [];

function startPolling($: EngineInterface): void {
  stopPolling();
  timers = [
    $.clock.every(POLL_MS, () => void tick($)),
    $.clock.every(PR_POLL_MS, () => void prTick($)),
  ];
}

function stopPolling(): void {
  for (const t of timers) t.cancel();
  timers = [];
}

type PrCallback = { dir: string; url: string; hostSession: string; message: string };

let callbackTicking = false;

/**
 * One `pr-watch` pass: the core resumes terminal sessions itself and hands back the desktop ones,
 * which only the app's messaging reaches. The core already marked them sent, so a failure is logged, not retried.
 */
async function callbackTick($: EngineInterface): Promise<void> {
  if (callbackTicking) return;
  callbackTicking = true;
  try {
    const r = await core<{ desktop: PrCallback[] }>($, "pr-watch", {}, 120000);
    if (!r.desktop.length) return;
    const self = payload<{ sessionId: string }>(
      await $.mcp.call("ccd_session_mgmt", "get_session", { session_id: "self" }),
    ).sessionId;
    for (const cb of r.desktop) {
      try {
        // send_message refuses the calling session, so a callback for this one is its own prompt.
        if (cb.hostSession === self) await $.prompt.submit({ text: cb.message });
        else {
          const sent = await $.mcp.call("ccd_session_mgmt", "send_message", {
            session_id: cb.hostSession,
            message: cb.message,
          });
          const text = sent.content.map((c) => c.text ?? "").join(" ");
          if (sent.isError || !/delivery: (delivered|queued)/.test(text)) throw new Error(text);
        }
      } catch (e) {
        $.ui.log(
          `PR callback for ${cb.url} not delivered to ${cb.hostSession}: ${(e as Error).message}`,
        );
      }
    }
  } catch (e) {
    $.ui.log(`PR callback pass failed: ${(e as Error).message}`);
  } finally {
    callbackTicking = false;
  }
}

let callbackTimer: { cancel: () => void } | null = null;

function startCallbacks($: EngineInterface): void {
  callbackTimer?.cancel();
  callbackTimer = $.clock.every(CALLBACK_POLL_MS, () => void callbackTick($));
  void callbackTick($);
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: "Sandbox workspaces" });
  await tick($);
  void prTick($);
  startPolling($);
}

/** Sidebar group that desktop sessions started in a workspace are filed under, when the person has made it. */
export const SESSION_GROUP = "Feature Workspaces";

// sandbox-core's DOT_DIRS (SW-7), new name first; the hook cannot import sandbox-core.
const DOT_DIRS = [".werkmeister", ".sandbox"];

async function hasWorkspaceYml($: EngineInterface, dir: string): Promise<boolean> {
  for (const d of DOT_DIRS) if (await $.fs.exists(`${dir}/${d}/workspace.yml`)) return true;
  return false;
}

/** A workspace or a folder inside one: `dir` or some ancestor holds `.sandbox/workspace.yml`. */
async function inWorkspace($: EngineInterface, dir: string): Promise<boolean> {
  for (let d = dir; d.length > 1; d = d.slice(0, d.lastIndexOf("/")) || "/") {
    if (await hasWorkspaceYml($, d)) return true;
  }
  return false;
}

/** Files this session under SESSION_GROUP when that group exists and the session sits in no group yet. */
async function fileInGroup($: EngineInterface): Promise<void> {
  try {
    const group = payload<{ id: string; name: string }[]>(
      await $.mcp.call("ccd_sidebar", "list_groups"),
    ).find((g) => g.name === SESSION_GROUP);
    if (!group) return;
    const self = payload<{ group?: { id: string } | null }>(
      await $.mcp.call("ccd_session_mgmt", "get_session", { session_id: "self" }),
    );
    if (self.group) return;
    await $.mcp.call("ccd_sidebar", "move_sessions", { session_ids: ["self"], group_id: group.id });
  } catch {
    /* groups not reported yet, or the app refused: the session stays where it is */
  }
}

/** A folder of workspaces (e.g. ~/features): some direct child holds `.sandbox/workspace.yml`. */
async function holdsWorkspaces($: EngineInterface, dir: string): Promise<boolean> {
  const entries = await $.fs.list(dir).catch(() => []);
  for (const d of entries) {
    if (d.kind === "dir" && (await hasWorkspaceYml($, `${dir}/${d.name}`))) return true;
  }
  return false;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "workspaces",
      description: "Open the sandbox workspaces pane",
    });
    await $.tool.register({
      name: FORM_TOOL,
      description:
        "Fill fields of the New Sandbox Workspace form in the /workspaces pane's Create tab, so the person can " +
        "set them from the prompt (e.g. paste a long starting prompt) and review before creating. Opens the pane on " +
        'the Create tab. Each value replaces the field; "" clears it. Fields: issue_id, feature (lowercase-hyphen ' +
        'slug), work_type, context_strategy, autonomous ("true" or "false"), model (an alias like sonnet, or a claude-… id), auto_stop ("true" or "false"), services (a list of choices), labels, test_path, task, ' +
        "description, starting_prompt (multi-line). Pass {} as fields to read the current values. Returns what the " +
        "form holds, values it left out and why, and what is still required. It never creates the workspace: the " +
        "person presses Create in the pane.",
      inputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "object",
            description: "Field key → value: a string, or a list of strings for services.",
            additionalProperties: {
              anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            },
          },
        },
        required: ["fields"],
      },
      isDeferred: false,
    });
    // A hot reload drops the old environment's timer but leaves the pane open: re-arm it.
    const panes = await $.ui.panes();
    if (panes.some((p) => p.id === PANE)) {
      startPolling($);
      void prTick($);
    } else if (e.isInteractive && (await holdsWorkspaces($, e.cwd))) await openPane($);
    if (e.surface === "desktop" && (await inWorkspace($, e.cwd))) await fileInGroup($);
    if (e.surface === "desktop") startCallbacks($);
    return next(e);
  });

  on("command.run", { command: "workspaces" }, async ($) => {
    await openPane($);
    return { text: "Workspaces pane opened." };
  });

  // A regex: the tool-name type only lists tools laid when the types were written, and this one registers at start.
  // The call's input fields arrive on the event itself, beside `tool` and `tool_use_id`.
  on("tool.call", { tool: /^mcp__werkmeister__workspace_form$/ }, async ($, e) => ({
    result: await fillFormTool($, e as unknown as Record<string, unknown>),
  })).catch(() => ({
    deny: "The workspace form could not be filled; open /workspaces and fill it by hand.",
  }));

  // The close-out MCP tool runs in its own server, which can't reach the app's session tools: archive here once it succeeded.
  on("tool.call", { tool: /^mcp__.*workspaces__close-out$/ }, async ($, e, next) => {
    const name = (e as unknown as { name?: unknown }).name;
    // Resolved first: the folder is gone once the call returns.
    const path =
      typeof name === "string"
        ? await core<{ path: string }>($, "workspace-path", { name }).then(
            (r) => r.path,
            () => null,
          )
        : null;
    const r = await next(e);
    if (!path || r.result === undefined || r.isError) return r;
    const lines = await archiveSessions($, path);
    return {
      ...r,
      context: [
        ...(r.context ?? []),
        `Desktop sessions in ${path}: ${lines.join("; ") || "none open"}`,
      ],
    };
  });

  on("ui.close", { id: PANE }, async (_$, e, next) => {
    stopPolling();
    return next(e);
  });

  // The multi-line fields (textarea.tsx) post every edit as { value }; the element is `f:<field key>`.
  on("ui.message", { requestId: PANE }, async ($, e, next) => {
    if (!e.element.startsWith("f:")) return next(e);
    const key = e.element.slice(2);
    const data = (e.data ?? {}) as { value?: unknown; focus?: unknown; submit?: unknown };
    if (data.focus === true) await $.state.set(FOCUSED, key);
    if (typeof data.value === "string") await setField($, key, data.value);
    // Enter in the issue field fills from the issue; elsewhere a one-line Enter does nothing.
    if (data.submit === true && key === "issue_id") void fetchIssue($);
    return {};
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e);
    const { value: rows = [] } = await $.state.get(ROWS);
    const { value: error = "" } = await $.state.get(ERROR);
    const { value: note = "" } = await $.state.get(NOTE);
    const { value: busy = "" } = await $.state.get(BUSY);
    const { value: confirm = "" } = await $.state.get(CONFIRM);
    const { value: reason = "" } = await $.state.get(REASON);
    const { value: infra = null } = await $.state.get(INFRA);
    const { value: snap = null } = await $.state.get(INTERCEPTS);
    const { value: tracker = null } = await $.state.get(TRACKER);
    const { value: prs = {} } = await $.state.get(PRS);
    const { value: tab = "list" } = await $.state.get(TAB);
    const { value: focus = false } = await $.state.get(FOCUS);
    // Mobile draws no Input or Select; there the Create tab hands the form to the model.
    const els = $.ui.resolve(e);
    const Input = "Input" in els ? els.Input : null;
    const Select = "Select" in els ? els.Select : null;

    const tabs = (
      <Box key="tabs" gap={1} marginBottom={1}>
        <Button
          key="tab:list"
          label="Workspaces"
          variant={tab === "list" ? "primary" : "secondary"}
          onPress={() => void $.state.set(TAB, "list")}
        />
        <Button
          key="tab:create"
          label="＋ Create"
          variant={tab === "create" ? "primary" : "secondary"}
          onPress={() => void openCreate($)}
        />
        {tab === "list" && (
          <Button
            key="focus"
            plain
            label={`${focus ? "☑" : "☐"} Focus`}
            onPress={() => void $.state.set(FOCUS, !focus)}
          />
        )}
      </Box>
    );

    const messages = (
      <Box key="messages" flexDirection="column">
        {note !== "" && (
          <Box key="note">
            <Text>{note}</Text>
          </Box>
        )}
        {error !== "" && (
          <Box key="error">
            <Text color="error">{error}</Text>
          </Box>
        )}
      </Box>
    );

    if (tab === "create") {
      if (!Input || !Select) {
        return (
          <Box flexDirection="column">
            {tabs}
            <Button
              key="create:go"
              label="＋ Create workspace"
              variant="primary"
              onPress={() => {
                void $.state.set(TAB, "list");
                void $.prompt.submit({ text: createPrompt("") });
              }}
            />
          </Box>
        );
      }
      const { value: form = null } = await $.state.get(FORM);
      const fields = form ? formFields(form.bundle) : [];
      const { value: draft = {} } = await $.state.get(DRAFT);
      const { value: formBusy = "" } = await $.state.get(FORM_BUSY);
      const text = (k: string) => (typeof draft[k] === "string" ? (draft[k] as string) : "");
      const picked = (k: string) => (Array.isArray(draft[k]) ? (draft[k] as string[]) : []);
      // Desktop and terminal draw a Client: there a multi-line field is textarea.tsx; elsewhere one line.
      const Client = "Client" in els ? els.Client : null;
      // Enter in a one-line field moves to the next one; the issue field's Enter fills from the issue.
      const { value: focused = "" } = await $.state.get(FOCUSED);
      // Text fields are textarea.tsx where a Client draws (no Enter chip, multi-line when asked);
      // elsewhere the app's one-line Input.
      const textField = (f: FormField) =>
        Client ? (
          <Client
            key={`f:${f.key}`}
            module="./textarea.tsx"
            props={{
              value: text(f.key),
              placeholder: f.placeholder,
              multiline: f.kind === "textarea",
              focused: focused === f.key,
            }}
          />
        ) : (
          <Input
            key={`f:${f.key}`}
            placeholder={f.placeholder}
            value={text(f.key)}
            submitLabel={f.key === "issue_id" ? "fill" : "save"}
            onInput={(v) => void setField($, f.key, v)}
            onSubmit={(v) =>
              void setField($, f.key, v).then(() =>
                f.key === "issue_id" ? fetchIssue($) : undefined,
              )
            }
          />
        );
      return (
        <Box flexDirection="column">
          {tabs}
          {!form && <Text dimColor>Loading the form…</Text>}
          {form && (
            <Box key="legend" marginBottom={1}>
              <Text dimColor>Fields marked * are required.</Text>
            </Box>
          )}
          {form &&
            fields.map((f) => (
              <Box key={`field:${f.key}`} flexDirection="column" marginBottom={1}>
                <Text
                  bold
                >{`${f.key === "issue_id" ? `${form.trackerLabel} issue` : f.title}${f.required ? " *" : ""}`}</Text>
                {f.help !== "" && f.key !== "issue_id" && <Text dimColor>{f.help}</Text>}
                {(f.kind === "text" || f.kind === "textarea") && textField(f)}
                {f.refine !== null && (
                  <Box key={`refine:${f.key}`} marginTop={1} gap={1}>
                    <Button
                      key={`create:refine:${f.key}`}
                      label={formBusy === "refine" ? "Refining…" : "✨ Refine with Claude"}
                      variant="secondary"
                      onPress={() =>
                        void (formBusy ? undefined : refineField($, f.key, f.refine ?? ""))
                      }
                    />
                    <Text dimColor>
                      Rewrites it as a clear instruction with a goal and acceptance criteria, using
                      the issue and your other choices.
                    </Text>
                  </Box>
                )}
                {f.kind === "check" && (
                  <Button
                    key={`f:${f.key}`}
                    plain
                    label={`${draft[f.key] === true ? "☑" : "☐"} ${f.title}`}
                    onPress={() => void setField($, f.key, draft[f.key] !== true)}
                  />
                )}
                {f.kind === "select" && (
                  <Select
                    key={`f:${f.key}`}
                    options={[
                      { value: "", label: "Choose…" },
                      ...f.options.map((o) => ({ value: o })),
                    ]}
                    value={text(f.key)}
                    onSelect={(v) => void setField($, f.key, v)}
                  />
                )}
                {f.kind === "multi" &&
                  optionGroups(f).map(([group, opts]) => (
                    <Box key={`group:${f.key}:${group}`} flexDirection="column" marginTop={1}>
                      {group !== "" && <Text dimColor>{group.toUpperCase()}</Text>}
                      <Box key={`opts:${f.key}:${group}`} flexWrap="wrap">
                        {opts.map((o) => {
                          const chosen = picked(f.key).includes(o);
                          return (
                            <Box key={`cell:${f.key}:${o}`} width={`${100 / COLUMNS}%`}>
                              <Button
                                key={`f:${f.key}:${o}`}
                                plain
                                label={`${chosen ? "☑" : "☐"} ${o}`}
                                onPress={() =>
                                  void setField(
                                    $,
                                    f.key,
                                    chosen
                                      ? picked(f.key).filter((x) => x !== o)
                                      : [...picked(f.key), o],
                                  )
                                }
                              />
                            </Box>
                          );
                        })}
                      </Box>
                    </Box>
                  ))}
                {f.key === "issue_id" && (
                  <Box key="fetch" flexDirection="column" marginTop={1}>
                    <Text
                      dimColor
                    >{`Optional. Reads the issue from ${form.trackerLabel} and fills in the fields below that are still empty.`}</Text>
                    <Box key="fetch:row" marginTop={1}>
                      <Button
                        key="create:fetch"
                        label={
                          formBusy === "fetch"
                            ? "Reading the issue…"
                            : "⤓ Fill empty fields from this issue"
                        }
                        variant="secondary"
                        onPress={() => void (formBusy ? undefined : fetchIssue($))}
                      />
                    </Box>
                  </Box>
                )}
              </Box>
            ))}
          {form && (
            <Box key="go">
              <Button
                key="create:go"
                label={formBusy === "create" ? "Creating…" : "＋ Create workspace"}
                variant="primary"
                onPress={() => void (formBusy ? undefined : submitForm($))}
              />
            </Box>
          )}
          {messages}
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        {tabs}
        <Box key="infra-bar" justifyContent="space-between" marginBottom={1}>
          <Box key="infra">
            <Text color={INFRA_COLOR[infra?.state ?? "unknown"]}>{infraLine(infra, tracker)}</Text>
          </Box>
          {busy === CONNECTING ? (
            <Box key="connecting">
              <Text dimColor>connecting…</Text>
            </Box>
          ) : (
            <Button
              key="connect"
              label="⚡ Connect"
              variant="secondary"
              onPress={() => void connect($)}
            />
          )}
        </Box>
        {rows.length === 0 && <Text dimColor>No workspaces.</Text>}
        {visibleRows(rows, focus).map((r) => (
          <Box
            key={`ws:${r.name}`}
            flexDirection="column"
            borderStyle="round"
            borderColor={BORDER[r.state]}
            borderDimColor={BORDER[r.state] === "inactive" ? true : undefined}
            paddingX={1}
            marginBottom={1}
          >
            <Box key={`head:${r.name}`} justifyContent="space-between">
              <Box key={`row:${r.name}`}>
                <Text bold>{r.name}</Text>
              </Box>
              {r.claude && (
                <Box key={`claude:${r.name}`}>
                  <Text color={CLAUDE[r.claude].color}>{CLAUDE[r.claude].text}</Text>
                </Box>
              )}
            </Box>
            {r.issueId && (
              <Box key={`issue:${r.name}`}>
                <Text>
                  {`${issueKind(r)}: `}
                  {r.issueUrl ? <Link href={r.issueUrl} label={r.issueId} /> : r.issueId}
                </Text>
              </Box>
            )}
            {r.task && (
              <Box key={`task:${r.name}`}>
                <Text>{r.task}</Text>
              </Box>
            )}
            {r.description && (
              <Box key={`desc:${r.name}`}>
                <Text dimColor>{r.description}</Text>
              </Box>
            )}
            {cardMeta(r) !== "" && (
              <Box key={`meta:${r.name}`}>
                <Text dimColor>{cardMeta(r)}</Text>
              </Box>
            )}
            {prLinks(prs[r.name] ?? []).length > 0 && (
              <Box key={`prs:${r.name}`} flexDirection="column">
                {prLinks(prs[r.name] ?? []).map((p) => (
                  <Text key={`pr:${p.key}`}>
                    {"pr: "}
                    <Link href={p.href} label={p.label} />
                    {p.state && (
                      <Text color={PR_COLOR[p.state]}>{` ⑂ ${p.state.toLowerCase()}`}</Text>
                    )}
                  </Text>
                ))}
              </Box>
            )}
            {sessionLine(r) && (
              <Box key={`session:${r.name}`}>
                <Text dimColor>{sessionLine(r)}</Text>
              </Box>
            )}
            {r.services.length > 0 && (
              <Box key={`services:${r.name}`} flexDirection="column">
                {r.services.map((svc) => {
                  const row = snap?.intercepts.find(
                    (x) => x.feature === r.feature && x.service === svc.name,
                  );
                  const c = interceptControl(row, r.feature, snap);
                  const asking = confirm === `${INTERCEPT}${r.name}/${svc.name}`;
                  const idle = busy !== r.name;
                  return (
                    <Box key={`svc:${r.name}/${svc.name}`} gap={1}>
                      <Text>
                        <Text color={SERVICE_COLOR[svc.state]}>●</Text> {svc.name}
                      </Text>
                      {c.kind === "off" && idle && !asking && (
                        <Button
                          key={`intercept:${r.name}/${svc.name}`}
                          label="Intercept"
                          variant="secondary"
                          onPress={() => void pressIntercept($, "ask", r.name, svc.name)}
                        />
                      )}
                      {c.kind === "off" && idle && asking && (
                        <Box gap={1}>
                          <Text color="warning">
                            {`Intercept ${svc.name}? Installs a traffic-agent sidecar on ${row?.deployment ?? svc.name} in the shared dev cluster.`}
                          </Text>
                          <Button
                            key={`intercept-yes:${r.name}/${svc.name}`}
                            label="✓ Yes, intercept"
                            variant="secondary"
                            onPress={() => void pressIntercept($, "yes", r.name, svc.name)}
                          />
                          <Button
                            key={`intercept-cancel:${r.name}/${svc.name}`}
                            label="Cancel"
                            variant="secondary"
                            onPress={() => void pressIntercept($, "cancel", r.name, svc.name)}
                          />
                        </Box>
                      )}
                      {c.kind === "active" && <Text color="success">{c.text}</Text>}
                      {c.kind === "active" && idle && (
                        <Button
                          key={`leave:${r.name}/${svc.name}`}
                          label="Leave"
                          variant="secondary"
                          onPress={() => void pressIntercept($, "leave", r.name, svc.name)}
                        />
                      )}
                      {c.kind !== "off" && c.kind !== "active" && <Text dimColor>{c.text}</Text>}
                    </Box>
                  );
                })}
              </Box>
            )}
            {busy === r.name ? (
              <Box key={`busy:${r.name}`}>
                <Text dimColor>working…</Text>
              </Box>
            ) : (
              <Box marginTop={1} justifyContent="space-between">
                <Box gap={1}>
                  {buttonsFor(r.state)
                    .filter((a): a is Lifecycle => LIFECYCLE.has(a))
                    .map((a) => (
                      <Button
                        key={`${a}:${r.name}`}
                        label={LABEL[a]}
                        variant="secondary"
                        onPress={() => void press($, a, r.name)}
                      />
                    ))}
                  <Box marginLeft={2} gap={1}>
                    <Button
                      key={`new:${r.name}`}
                      label={LABEL.new}
                      variant="secondary"
                      onPress={() => void press($, "new", r.name)}
                    />
                    {sessionTitle(r) && (
                      <Button
                        key={`continue:${r.name}`}
                        label={`↗ Continue in ${continueTarget(r)}`}
                        variant="secondary"
                        onPress={() => void press($, "continue", r.name)}
                      />
                    )}
                    {r.session?.beside && (
                      <Button
                        key={`beside:${r.name}`}
                        label={LABEL.beside}
                        variant="secondary"
                        onPress={() => void press($, "beside", r.name)}
                      />
                    )}
                    {r.session && (
                      <Button
                        key={`pin:${r.name}`}
                        label={r.session.pinned ? "📌 Unpin" : "📌 Pin"}
                        variant="secondary"
                        onPress={() => void press($, "pin", r.name)}
                      />
                    )}
                  </Box>
                </Box>
                {/* Buttons take no colour; Abandon's label turns red under the pointer and its confirm prompt is red text beside it. */}
                <Box gap={1}>
                  {lifecycleButtonsFor(r).map((a) => (
                    <Button
                      key={`${a}:${r.name}`}
                      label={LABEL[a]}
                      variant="secondary"
                      onPress={() => void press($, a, r.name)}
                    />
                  ))}
                  {confirm === CLOSE_OUT + r.name && (
                    <Box key={`closeout-confirm:${r.name}`}>
                      <Text color="warning">{"Close out and remove this workspace?"}</Text>
                    </Box>
                  )}
                  {confirm === ABANDON + r.name && Input && (
                    <Input
                      key={`reason:${r.name}`}
                      placeholder="Why abandon? (required)"
                      value={reason}
                      submitLabel="save"
                      onInput={(v) => void $.state.set(REASON, v)}
                      onSubmit={(v) => void $.state.set(REASON, v)}
                    />
                  )}
                  {confirm === ABANDON + r.name && (
                    <Box key={`abandon-confirm:${r.name}`}>
                      <Text color="error">
                        {"Abandon: pushes and keeps every branch, removes the workspace"}
                      </Text>
                    </Box>
                  )}
                  {endActionFor(r, Input !== null) === "closeout" && (
                    <Button
                      key={`closeout:${r.name}`}
                      label={confirm === CLOSE_OUT + r.name ? "✓ Yes, close out" : LABEL.closeout}
                      variant="secondary"
                      onPress={() => void press($, "closeout", r.name)}
                    />
                  )}
                  {endActionFor(r, Input !== null) === "abandon" && (
                    <Button
                      key={`abandon:${r.name}`}
                      label={confirm === ABANDON + r.name ? "✕ Yes, abandon" : LABEL.abandon}
                      variant="secondary"
                      dimColor
                      hover={{ color: "error", dimColor: false }}
                      onPress={() => void press($, "abandon", r.name)}
                    />
                  )}
                </Box>
              </Box>
            )}
          </Box>
        ))}
        {messages}
      </Box>
    );
  });
};
