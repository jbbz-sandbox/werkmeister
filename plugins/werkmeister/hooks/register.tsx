import type { Color, EngineInterface, Register } from "claude-code";

import type {
  Draft,
  FormBundle,
  FormField,
  InfraStatus,
  InterceptRow,
  InterceptsSnapshot,
  RepoPr,
  ServiceHealth,
  WorkspaceResources,
  WorkspaceRow,
} from "../types";
import { displayModel, hostLine, type Tone, type WorkspaceDisplay } from "./display-model";

export const PLUGIN = "werkmeister";
export const PANE = "workspaces";

// Workspace reads and actions run werkmeister-core in a node child, the way the former /workspace-form mod did:
// the plugin's own MCP server is not answerable from a hook in the desktop host, a host process is.
// stdin carries one JSON request { op, ...args }; stdout ends with one JSON line { ok, result | error }.
// The core package is found from $WERKMEISTER_CORE_PATH, else from where the `werkmeister` binary resolves `werkmeister-core`.
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
  let file = process.env.WERKMEISTER_CORE_PATH
  if (!file) {
    const which = execFileSync('sh', ['-c', 'command -v werkmeister']).toString().trim()
    const bin = realpathSync(which)
    // npm's global bin is a symlink into the package. pnpm's (pnpm link --global) is a shell shim
    // in PNPM_HOME, with the package under PNPM_HOME/global/<n>/node_modules.
    const pnpmGlobal = join(dirname(which), 'global')
    const dirs = [dirname(bin)]
    try { for (const v of readdirSync(pnpmGlobal)) dirs.push(join(pnpmGlobal, v, 'node_modules', 'werkmeister')) } catch {}
    for (const dir of dirs) {
      if (!file) try { file = createRequire(dir + '/x').resolve('werkmeister-core') } catch {}
    }
    if (!file) throw new Error('Cannot find werkmeister-core next to ' + which + '; set WERKMEISTER_CORE_PATH')
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
    try { cfg = yaml.parse(readFileSync(join(w.path, '.werkmeister', 'workspace.yml'), 'utf8')) ?? {} } catch { /* not initialised */ }
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
    'claim-resume-nudge': async () => ({ message: await core.claimResumeNudge(args.name) }),
    'workspace-resources': () => core.getWorkspaceResources(),
    // The same snapshot \`werkmeister status --intercepts --json\` prints: the CLI stays the one source of intercept state.
    intercepts: async () => (await sibling('status.js')).interceptsSnapshot(),
    // docker mode from the pane: it has no TTY for host mode's root-daemon sudo prompt (SW-12).
    'intercept-start': async () => (await sibling('telepresence.js')).startIntercept({ ...(await interceptArgs()), dockerDaemon: args.dockerDaemon === true }),
    'intercept-leave': async () => ({ left: await (await sibling('telepresence.js')).leaveIntercept({ ...(await interceptArgs()), dockerDaemon: args.dockerDaemon === true }) }),
    'workspace-prs': () => core.getWorkspacePRs(),
    connect: async () => ({ ok: await (await import(pathToFileURL(join(dirname(file), 'infra.js')).href)).up() }),
    'workspace-action': () => core.runWorkspaceAction(args.name, args.action),
    'workspace-path': async () => ({ path: await core.resolveWorkspaceDir(args.name) }),
    'start-args': () => core.startArgs(args.path),
    'pr-status': async () => ({ command: (await core.refreshPrStatus(args.path)).lines.join('\\n') || 'no PR files' }),
    'pr-watch': () => core.watchPrs({ desktop: true }),
    'close-out': () => core.closeOut(args.name, args.abandon !== undefined ? { abandon: args.abandon } : {}),
    'claude-resume': () => core.resumeClaudeInTerminal(args.name),
    'follow-logs': () => core.followLogsInTerminal(args.name),
    'open-feature': () => core.openFeatureBrowser(args.name),
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
    // The create form's rules live in werkmeister-core, shared with the browser form.
    'validate-form': () => core.validateFormData(args.bundle, args.formData),
    'merge-form': () => core.mergeFormData(args.current, args.incoming),
  }
  if (!ops[op]) throw new Error('unknown op ' + op)
  out({ ok: true, result: await ops[op]() })
} catch (e) {
  out({ ok: false, error: (e && e.message) || String(e) })
}
`;

/** One werkmeister-core call in a node child; throws with the child's error text. */
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
        `werkmeister-core gave no result (exit ${r.exitCode})`,
    );
  }
  if (!o.ok || o.result === undefined) throw new Error(o.error ?? "werkmeister-core failed");
  return o.result;
}
export const POLL_MS = 5000;
/** PRs refresh this often: each workspace × repo is a `gh` network call. */
export const PR_POLL_MS = 60000;
/** CPU/memory refresh this often: the stats sweep costs the daemon about a second (SW-41). */
export const RESOURCE_POLL_MS = 30000;
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
const RESOURCES = { plugin: "werkmeister", key: "resources" } as const;
const INTERCEPTS = { plugin: "werkmeister", key: "intercepts" } as const;
/** CONFIRM prefix for a pending intercept ON: `intercept:<workspace>/<service>`. */
const INTERCEPT = "intercept:";
const PRS = { plugin: "werkmeister", key: "prs" } as const;
const PRS_POLL = { plugin: "werkmeister", key: "prsPoll" } as const;
const LEGEND = { plugin: "werkmeister", key: "legend" } as const;
/** BUSY while `werkmeister connect` runs; no workspace name has parentheses. */
const CONNECTING = "(connect)";

const FORM = { plugin: "werkmeister", key: "formSchema" } as const;
const DRAFT = { plugin: "werkmeister", key: "draft" } as const;
const FORM_BUSY = { plugin: "werkmeister", key: "formBusy" } as const;
const FOCUSED = { plugin: "werkmeister", key: "focusedField" } as const;

/** Mobile draws no Input or Select, so there the Create tab hands the form to the model instead. */
export function createPrompt(issueId: string): string {
  const id = issueId.trim();
  return `Create a new workspace with the werkmeister:workspace skill${id ? `, pre-filled from issue ${id}` : ""}.`;
}

/**
 * The create form's fields from the same RJSF bundle the browser form renders
 * (getFormSchema: the terminal wizard's prompts), in its `ui:order`. An array
 * with choices is a multi-pick; a string with choices a select; a boolean a
 * checkbox; a `textarea` widget a multi-line field; the rest one line.
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
      title: p.title ?? k,
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

/** Why the draft can't be submitted, one line per field in form order; [] when it can. The rules are werkmeister-core's validateFormData. */
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
    // The tracker lookup runs in werkmeister-core; the distillation runs on this session's own client and login.
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
 * "Refine with Claude": rewrite the field with werkmeister-core's refine prompt, the issue and the other fields as context.
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
    // Same extraction as werkmeister-core's extractResult.
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
    claude: {
      state: string;
      agent: "working" | "needs-you" | "done" | "idle";
      at?: string | null;
      question?: string | null;
    };
    phase?: string | null;
    autonomous?: boolean;
    lastActivity?: string | null;
    project?: string | null;
    started?: WorkspaceRow["started"];
    crashLoops?: WorkspaceRow["crashLoops"];
    paused?: WorkspaceRow["paused"];
    resumeNudge?: boolean;
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
      claude: {
        agent: s?.claude.agent ?? "idle",
        at: s?.claude.at ?? null,
        question: s?.claude.question ?? null,
      },
      phase: s?.phase ?? null,
      autonomous: s?.autonomous ?? false,
      lastActivity: s?.lastActivity ?? null,
      project: s?.project ?? null,
      started: s?.started ?? null,
      crashLoops: s?.crashLoops ?? [],
      paused: s?.paused ?? null,
      resumeNudge: s?.resumeNudge ?? false,
      session: sessionFor(w.path, allPaths, sessions),
    };
  });
}

/** With the toggle on, only workspaces labelled `focus` (in `.werkmeister/workspace.yml`) are listed. */
export function visibleRows(rows: WorkspaceRow[], focus: boolean): WorkspaceRow[] {
  return focus ? rows.filter((r) => r.labels.includes("focus")) : rows;
}

/** PR file statuses that say more than gh can: shipped is merged and released, abandoned is the workspace's call. */
const PAST_GH = new Set(["shipped", "abandoned"]);

/**
 * The row with each PR file's status replaced by the PR poll's live state for its repo, and the lifecycle state
 * recomputed as werkmeister-core's `lifecycleOf` does, so the meta line and buttons never contradict the card's
 * `⑂` PR line (SW-50). A repo the poll has no PR for, or no poll yet, keeps its file status.
 */
export function withLivePrs(r: WorkspaceRow, live: RepoPr[]): WorkspaceRow {
  const l = r.lifecycle;
  if (!l || l.state === "closed-out") return r;
  const prs = l.prs.map((p) => {
    // The poll follows the worktree's current branch; an earlier PR file keeps its own status (SW-103).
    const state = live
      .find((x) => x.repo === p.dir && (!p.url || x.url === p.url))
      ?.state?.toLowerCase();
    return state && state !== p.status && !PAST_GH.has(p.status) ? { ...p, status: state } : p;
  });
  if (prs.every((p, i) => p === l.prs[i])) return r;
  const all = (s: string[]) => prs.every((p) => s.includes(p.status));
  const state = all(["abandoned"])
    ? "abandoned"
    : all(["shipped", "closed", "abandoned"])
      ? "shipped"
      : all(["merged", "shipped", "closed", "abandoned"])
        ? "merged"
        : prs.some((p) => p.status === "open")
          ? "pr-open"
          : all(["approved"])
            ? "ready"
            : "working";
  return { ...r, lifecycle: { state, prs } };
}

/** The display model's tones in the pane's named colours: the pane has no solid amber, so Needs you is bold warning. */
const TONE: Record<Tone, Color> = {
  ok: "success",
  warn: "warning",
  err: "error",
  off: "inactive",
  pr: "merged",
  needs: "warning",
};

/** The shared display model (docs/ui-spec.md § The card) for one row; `prs` null when the PR poll failed. */
export function display(
  r: WorkspaceRow,
  prs: RepoPr[] | null,
  now: Date,
  resources: WorkspaceResources | null = null,
): WorkspaceDisplay {
  return displayModel(r, {
    // Not `prs?.map`: null (lookup failed) must reach the model as null, not as undefined (no PRs).
    prs:
      prs === null
        ? null
        : prs.map((p) => ({
            url: p.url,
            state: p.state,
            ci: p.ci ?? null,
            failingChecks: p.failingChecks ?? 0,
          })),
    lifecycle: r.lifecycle?.state ?? null,
    now,
    usage: r.project ? resources?.projects[r.project] : null,
  });
}

/** The card's resources line, `12.3% CPU · 410 MiB · started 2 h ago by up`; '' when neither is known. */
export function resourcesLine(d: WorkspaceDisplay): string {
  return [d.usage?.text, d.started?.text].filter(Boolean).join(" · ");
}

/** One run of the compact status line: `key` parts are the dim labels, `href` makes it a link. */
export type Part = { text: string; tone?: Tone; key?: true; href?: string };

/**
 * The compact line, always containers · PRs · workflow (ui-spec § The card → Compact). `loaded` is false
 * before the first PR poll, which would otherwise read as `None yet`.
 */
export function metaParts(d: WorkspaceDisplay, loaded: boolean): Part[] {
  const sep: Part = { text: " · ", key: true };
  const prs: Part[] =
    d.prsEmpty?.tone === "warn"
      ? [{ text: `${d.prsEmpty.text} · retry`, tone: "warn" }]
      : [
          { text: "PRs ", key: true },
          ...(!loaded
            ? [{ text: "loading…", key: true } as const]
            : d.prsEmpty
              ? [{ text: d.prsEmpty.text, tone: d.prsEmpty.tone }]
              : d.prs.flatMap((p, i): Part[] => [
                  ...(i ? [{ text: ", ", key: true } as const] : []),
                  { text: p.ref, href: p.url },
                  { text: ` ${p.state.text}`, tone: p.state.tone },
                  ...(p.ci ? [sep, { text: p.ci.text, tone: p.ci.tone }] : []),
                ])),
        ];
  return [
    { text: "containers ", key: true },
    { text: d.containers.text, tone: d.containers.tone },
    sep,
    ...prs,
    ...(d.workflow.kind === "none" ? [] : [sep, { text: d.workflow.compact }]),
  ];
}

/** The subtitle: work type · task title from workspace.yml, never the session title (SW-52). */
export function subtitle(r: WorkspaceRow): string {
  const type = r.workType
    ? (WORK_TYPE[r.workType] ?? r.workType.charAt(0).toUpperCase() + r.workType.slice(1))
    : null;
  return [type, r.task].filter(Boolean).join(" · ");
}

/** The design's type tags (Bug, Feature, …); the wizard's `bugfix` reads as Bug. */
const WORK_TYPE: Record<string, string> = { bugfix: "Bug" };

/** A session Continue can pick up: one the app lists, or the newest on disk. */
function hasSession(r: WorkspaceRow): boolean {
  return r.session !== null || r.sessionTitle !== null;
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

/** ▶ Start work (SW-153): a run nobody has started — no session, and the first stage has no output yet. */
export function canStart(r: WorkspaceRow): boolean {
  return !hasSession(r) && r.stage?.index === 1;
}

/** The infra line: `infra partial · 4 of 5 up · down: caddy`; services not healthy or running are named. */
export function infraLine(
  i: InfraStatus | null,
  t: { ok: boolean; reason?: string; fix: string } | null = null,
): string {
  const tracker = t && !t.ok ? `tracker: ${t.reason} · ${t.fix}` : null;
  if (!i) return ["infra · unknown", tracker].filter(Boolean).join(" · ");
  const bad = i.services
    .filter((s) => s.state !== "healthy" && s.state !== "running")
    .map((s) => `${s.state}: ${s.name}`);
  return [`infra ${i.state}`, i.total > 0 ? `${i.running} of ${i.total} up` : null, ...bad, tracker]
    .filter(Boolean)
    .join(" · ");
}

const INFRA_COLOR: Record<InfraStatus["state"], "success" | "warning" | "error"> = {
  up: "success",
  partial: "warning",
  down: "error",
  unknown: "warning",
};

/** `werkmeister connect`: brings up the shared infra, then refreshes so the infra line shows the result. */
async function connect($: EngineInterface): Promise<void> {
  const { value: busy = "" } = await $.state.get(BUSY);
  if (busy !== "") return;
  await $.state.set(BUSY, CONNECTING);
  await $.state.set(NOTE, "werkmeister connect…");
  try {
    const r = await core<{ ok: boolean }>($, "connect", {}, 600000);
    await $.state.set(
      NOTE,
      r.ok
        ? "werkmeister connect: done"
        : "werkmeister connect: some infra failed to start; check docker and your kubeconfig",
    );
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message);
  } finally {
    await $.state.set(BUSY, "");
  }
  await tick($);
}

/**
 * Sends Resume's "continue" (SW-70) to each workspace's Desktop session: only the pane can name it. The claim
 * removes the file first, so a failure is logged, not retried; a row with no Desktop session leaves it be.
 */
async function deliverNudges($: EngineInterface, rows: WorkspaceRow[]): Promise<void> {
  const due = rows.filter((r) => r.resumeNudge && r.session);
  if (!due.length) return;
  const self = payload<{ sessionId: string }>(
    await $.mcp.call("ccd_session_mgmt", "get_session", { session_id: "self" }),
  ).sessionId;
  for (const r of due) {
    try {
      const { message } = await core<{ message: string | null }>($, "claim-resume-nudge", {
        name: r.name,
      });
      if (!message || !r.session) continue;
      // send_message refuses the calling session, so a nudge for this one is its own prompt.
      if (r.session.id === self) await $.prompt.submit({ text: message });
      else {
        const sent = await $.mcp.call("ccd_session_mgmt", "send_message", {
          session_id: r.session.id,
          message,
        });
        const text = sent.content.map((c) => c.text ?? "").join(" ");
        if (sent.isError || !/delivery: (delivered|queued)/.test(text)) throw new Error(text);
      }
    } catch (e) {
      $.ui.log(`Resume "continue" not delivered to ${r.name}: ${(e as Error).message}`);
    }
  }
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
    const rows = buildRows(list, status, sessions);
    await $.state.set(ROWS, rows);
    await deliverNudges($, rows);
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

/**
 * One service's toggle, or null for a local-only service (SW-21). The VS Code tree's
 * `interceptView` rules; this standalone plugin can't import it.
 */
export function interceptControl(
  service: string,
  row: InterceptRow | undefined,
  feature: string | null,
  snap: InterceptsSnapshot | null,
): InterceptControl | null {
  // A failed lookup can't tell remote from local, so it keeps "unavailable" on every row.
  if (snap === null) return { kind: "unavailable", text: "intercept state unavailable" };
  if (!snap.remote_services.includes(service)) return null;
  // Installed but disconnected falls through: Intercept connects first (SW-12).
  if (!(snap.installed ?? snap.available))
    return { kind: "unavailable", text: "intercepts unavailable" };
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
      await core($, "intercept-start", { name, feature, service, dockerDaemon: true }, 180000);
      await $.state.set(NOTE, `${service}: intercepted (x-feature: ${feature})`);
    } else {
      await core($, "intercept-leave", { name, feature, service, dockerDaemon: true }, 60000);
      await $.state.set(NOTE, `${service}: left intercept`);
    }
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message);
  } finally {
    await $.state.set(BUSY, "");
  }
  await tick($);
}

export type Action =
  | "up"
  | "stop"
  | "restart"
  | "down"
  | "pause"
  | "resume"
  | "new"
  | "start"
  | "continue"
  | "pin"
  | "prs"
  | "logs"
  | "feature"
  | "closeout"
  | "abandon"
  | "cancel";
type Lifecycle = "up" | "stop" | "restart" | "down" | "pause" | "resume";
const LIFECYCLE = new Set<Action>(["up", "stop", "restart", "down", "pause", "resume"]);

const LABEL: Record<Exclude<Action, "continue" | "pin">, string> = {
  up: "▶ Up",
  stop: "■ Stop",
  restart: "↻ Restart",
  down: "⏻ Down",
  pause: "⏸ Pause",
  resume: "▶ Resume",
  new: "＋ New session",
  start: "▶ Start work",
  prs: "↻ Refresh PRs",
  logs: "Logs",
  feature: "Open feature ↗",
  closeout: "✓ Close out",
  abandon: "✕ Abandon…",
  cancel: "Cancel",
};

/** What a card offers, one list per group in draw order; `issue` is the Open issue link (ui-spec § Actions). */
export type CardActions = {
  primary: Action;
  session: Action[];
  containers: Action[];
  work: (Action | "issue")[];
};

/**
 * ui-spec § Actions, Pane: the display model's primary, highlighted where it sits, and the buttons grouped by
 * what they act on. Buttons that don't apply are left out. Stop stays hidden once the work shipped (06 Actions).
 */
export function actionsFor(r: WorkspaceRow, d: WorkspaceDisplay, canType: boolean): CardActions {
  const session = hasSession(r);
  const off = r.state === "down" || r.state === "stopped";
  const live = r.state === "up" || r.state === "partial";
  const shipped = r.lifecycle?.state === "shipped";
  const want: Action = d.primary.action === "close-out" ? "closeout" : d.primary.action;
  const start = canStart(r);
  // A fresh run outranks ▶ Up: the run brings its containers up itself at the gate.
  // Continue with no session would resume nothing: New session takes its place.
  const primary: Action =
    start && want !== "closeout" ? "start" : want === "continue" && !session ? "new" : want;
  const containers: Action[] =
    r.paused != null
      ? ["resume", "stop", "down"]
      : off
        ? ["up", ...(r.state === "stopped" ? (["down"] as const) : [])]
        : [
            ...(shipped ? [] : (["stop"] as const)),
            "pause",
            "restart",
            "down",
            ...(live ? (["logs", "feature"] as const) : []),
          ];
  return {
    primary,
    session: [
      ...(session ? (["continue"] as const) : []),
      ...(start ? (["start"] as const) : []),
      "new",
      ...(r.session ? (["pin"] as const) : []),
    ],
    containers,
    work: [
      "prs",
      ...(r.issueUrl ? (["issue"] as const) : []),
      ...(canCloseOut(r) ? (["closeout"] as const) : []),
      // Abandon needs a typed reason, so none where no Input draws.
      ...(canType ? (["abandon"] as const) : []),
    ],
  };
}

/** Close out applies (#160) once every PR settled, to a spike with none, or as a retry after a failed removal. */
export function canCloseOut(r: WorkspaceRow): boolean {
  const s = r.lifecycle?.state;
  return (
    s === "shipped" ||
    s === "abandoned" ||
    s === "closed-out" ||
    (r.workType === "spike" && !r.lifecycle?.prs.length)
  );
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
      // ↻ Refresh PRs is also the retry for `PRs unavailable`.
      if (action === "prs") await prTick($);
    }
  } catch (err) {
    await $.state.set(NOTE, (err as Error).message);
  } finally {
    await $.state.set(BUSY, "");
  }
  await tick($);
}

function startDraft(name: string, args: Record<string, unknown>): string {
  return `Start the run for \`${name}\`: call \`mcp__ccd_session__start_session\` once with exactly these arguments, then reply with the new session's link:\n\n\`\`\`json\n${JSON.stringify(args)}\n\`\`\``;
}

/**
 * ▶ Start work: one Desktop session in the workspace folder, with the title, model, prompt and background
 * werkmeister-core builds (the same ones `werkmeister start-args` prints for next-wave). A refused or failed call
 * becomes a draft in this session's prompt box asking its model to make it. BUSY drops a second press.
 */
async function startWork($: EngineInterface, name: string): Promise<void> {
  const { value: rows = [] } = await $.state.get(ROWS);
  const row = rows.find((r) => r.name === name);
  if (!row) return;
  await $.state.set(BUSY, name);
  await $.state.set(NOTE, `${name}: starting the run…`);
  try {
    const a = await core<{ title: string; model?: string; prompt: string; background: string }>(
      $,
      "start-args",
      { path: row.path },
    );
    const args = {
      initiation: "user_asked",
      cwd: row.path,
      use_worktree: false,
      context: "fresh",
      ...a,
    };
    const r = await $.mcp
      .call("ccd_session", "start_session", args)
      .catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
    const text = r.content
      .map((c) => c.text ?? "")
      .join(" ")
      .trim();
    if (!r.isError) {
      await $.state.set(NOTE, "");
      $.ui.toast(`Started "${a.title}". ⇆ Open beside on its card opens it.`);
    } else {
      // Auto mode refuses the pane's own call, and the app refuses a start on a turn a plugin submits; the
      // person's Enter on a draft makes it their own request (SW-157).
      const draft = await $.prompt.fill({ text: startDraft(name, args) });
      await $.state.set(
        NOTE,
        draft.isFilled
          ? `${name}: press Enter in the chat to start the run`
          : `${name}: start refused: ${text}`,
      );
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
  if (
    action === "cancel" ||
    (pending !== "" && pending !== CLOSE_OUT + name && pending !== ABANDON + name)
  ) {
    await $.state.set(CONFIRM, "");
    await $.state.set(REASON, "");
  }
  if (action === "cancel") return;

  if (action === "start") return startWork($, name);

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

  if (action === "logs" || action === "feature") {
    try {
      if (action === "logs") {
        await core($, "follow-logs", { name });
        $.ui.toast(`Following ${name}'s logs in a Terminal window`);
      } else {
        await core($, "open-feature", { name });
        $.ui.toast(`Opening ${name}'s feature in the browser`);
      }
    } catch (err) {
      await $.state.set(NOTE, (err as Error).message);
    }
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
        // A claude:// Link draws nothing on the desktop pane (probe, 2026-10-09). Split, not focus: the session
        // opens beside this chat, which stays in place with the pane.
        const r = await $.mcp.call("ccd_window", "open_session_in", {
          session_id: row.session.id,
          target: "split",
        });
        if (!r.isError) return;
        // open_session_in splits only sessions this one started; the session's own link opens any, in this chat's place.
        if (row.session.link) {
          await core($, "open-claude-link", { url: row.session.link });
          $.ui.toast(
            `To keep this chat in sight: right-click "${row.session.title}" in the sidebar → Open in → Split view`,
          );
        } else $.ui.toast(`Open "${row.session.title}" from the sidebar`);
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
/** Refreshes PRs once; a failure marks every card `PRs unavailable` until a poll succeeds. */
async function prTick($: EngineInterface): Promise<void> {
  if (prTicking) return;
  prTicking = true;
  try {
    const r = await core<{ name: string; repos: RepoPr[] }[]>($, "workspace-prs", {}, 120000);
    const { value: poll } = await $.state.get(PRS_POLL);
    await $.state.set(PRS, Object.fromEntries(r.map((w) => [w.name, w.repos])));
    if (poll === "failed") await $.state.set(PRS_POLL, "ok");
  } catch {
    // The failure may be this environment ending (a reload, a closed pane), which refuses the write too.
    await $.state.set(PRS_POLL, "failed").catch(() => undefined);
  } finally {
    prTicking = false;
  }
}

let resourceTicking = false;
/** One stats sweep; kept off the row tick so a slow daemon never costs the rows. */
async function resourceTick($: EngineInterface): Promise<void> {
  if (resourceTicking) return;
  resourceTicking = true;
  try {
    await $.state.set(RESOURCES, await core<WorkspaceResources>($, "workspace-resources"));
  } catch {
    await $.state.set(RESOURCES, null).catch(() => undefined);
  } finally {
    resourceTicking = false;
  }
}

let timers: { cancel: () => void }[] = [];

function startPolling($: EngineInterface): void {
  stopPolling();
  timers = [
    $.clock.every(POLL_MS, () => void tick($)),
    $.clock.every(PR_POLL_MS, () => void prTick($)),
    $.clock.every(RESOURCE_POLL_MS, () => void resourceTick($)),
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
  await $.ui.open({ id: PANE, title: "Werkmeister workspaces" });
  await tick($);
  void prTick($);
  void resourceTick($);
  startPolling($);
}

/** Sidebar group that desktop sessions started in a workspace are filed under, when the person has made it. */
export const SESSION_GROUP = "Feature Workspaces";

async function hasWorkspaceYml($: EngineInterface, dir: string): Promise<boolean> {
  return $.fs.exists(`${dir}/.werkmeister/workspace.yml`);
}

/** A workspace or a folder inside one: `dir` or some ancestor holds `.werkmeister/workspace.yml`. */
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

/** A folder of workspaces (e.g. ~/features): some direct child holds `.werkmeister/workspace.yml`. */
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
      description: "Open the werkmeister workspaces pane",
    });
    await $.tool.register({
      name: FORM_TOOL,
      description:
        "Fill fields of the New Werkmeister Workspace form in the /workspaces pane's Create tab, so the person can " +
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
      void resourceTick($);
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
  on("tool.call", { tool: /^mcp__.*werkmeister__close-out$/ }, async ($, e, next) => {
    const name = (e as unknown as { workspace?: unknown }).workspace;
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
    const { value: loadedRows } = await $.state.get(ROWS);
    const rows = loadedRows ?? [];
    const { value: error = "" } = await $.state.get(ERROR);
    const { value: note = "" } = await $.state.get(NOTE);
    const { value: busy = "" } = await $.state.get(BUSY);
    const { value: confirm = "" } = await $.state.get(CONFIRM);
    const { value: reason = "" } = await $.state.get(REASON);
    const { value: infra = null } = await $.state.get(INFRA);
    const { value: resources } = await $.state.get(RESOURCES);
    // No line before the first sweep lands, `host load n/a` once one failed.
    const host = resources === undefined ? null : hostLine(resources?.host ?? null);
    const { value: snap = null } = await $.state.get(INTERCEPTS);
    const { value: tracker = null } = await $.state.get(TRACKER);
    const { value: polled } = await $.state.get(PRS);
    const prs = polled ?? {};
    const { value: tab = "list" } = await $.state.get(TAB);
    const { value: focus = false } = await $.state.get(FOCUS);
    const { value: legend = false } = await $.state.get(LEGEND);
    const { value: prsPoll } = await $.state.get(PRS_POLL);
    const now = new Date(await $.clock.now());
    const shown = visibleRows(rows, focus).map((r) => withLivePrs(r, prs[r.name] ?? []));
    const needing = rows.filter((r) => r.claude.agent === "needs-you").length;
    // Mobile draws no Input or Select; there the Create tab hands the form to the model.
    const els = $.ui.resolve(e);
    const Input = "Input" in els ? els.Input : null;
    const Select = "Select" in els ? els.Select : null;

    const tabs = (
      <Box key="tabs" gap={1} marginBottom={1}>
        <Button
          key="tab:list"
          label={`Workspaces${needing ? ` · ${needing} need${needing === 1 ? "s" : ""} you` : ""}`}
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
            label={`${focus ? "☑" : "☐"} Focused only`}
            onPress={() => void $.state.set(FOCUS, !focus)}
          />
        )}
        {tab === "list" && (
          <Button key="legend" plain label="?" onPress={() => void $.state.set(LEGEND, !legend)} />
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

    const canType = Input !== null;
    const part = (p: Part, i: number) =>
      p.href ? (
        <Link key={`p${i}`} href={p.href} label={p.text} />
      ) : (
        <Text key={`p${i}`} color={p.tone && TONE[p.tone]} dimColor={p.key}>
          {p.text}
        </Text>
      );
    const card = (r: WorkspaceRow) => {
      const d = display(r, prsPoll === "failed" ? null : (prs[r.name] ?? []), now, resources);
      const vitals = resourcesLine(d);
      const acts = actionsFor(r, d, canType);
      const label = (a: Action) =>
        a === "continue"
          ? continueTarget(r) === "Desktop"
            ? "⇆ Open beside"
            : `↗ Continue in ${continueTarget(r)}`
          : a === "pin"
            ? r.session?.pinned
              ? "📌 Unpin"
              : "📌 Pin"
            : LABEL[a];
      const button = (a: Action | "issue", variant?: "primary" | "secondary") =>
        a === "issue" ? (
          <Box key={`issue:${r.name}`}>
            <Link href={r.issueUrl ?? ""} label="Open issue ↗" />
          </Box>
        ) : (
          <Button
            key={`${a}:${r.name}`}
            label={label(a)}
            variant={variant ?? (a === acts.primary ? "primary" : "secondary")}
            // Buttons take no colour; Abandon's label turns red under the pointer.
            {...(a === "abandon"
              ? { dimColor: true, hover: { color: "error", dimColor: false } }
              : {})}
            onPress={() => void press($, a, r.name)}
          />
        );
      // Containers draw their reads (Logs, Open feature) on a line under the lifecycle buttons.
      const reads = (a: Action | "issue") => a === "logs" || a === "feature";
      const groups = (
        [
          ["session", [acts.session]],
          ["containers", [acts.containers.filter((a) => !reads(a)), acts.containers.filter(reads)]],
          ["work", [acts.work]],
        ] as const
      )
        .map(([g, lines]) => [g, lines.filter((l) => l.length > 0)] as const)
        .filter(([, lines]) => lines.length > 0);
      const sub = subtitle(r);
      const confirming =
        confirm === CLOSE_OUT + r.name
          ? "closeout"
          : confirm === ABANDON + r.name
            ? "abandon"
            : null;
      return (
        <Box
          key={`ws:${r.name}`}
          flexDirection="column"
          // The highlight means one thing (ui-spec rule 4): only Needs you changes the border.
          borderStyle={d.needs ? "bold" : "round"}
          borderColor={d.needs ? "warning" : "inactive"}
          borderDimColor={d.needs ? undefined : true}
          paddingX={1}
          marginBottom={1}
        >
          <Box key={`head:${r.name}`} justifyContent="space-between" gap={1}>
            <Box key={`row:${r.name}`}>
              <Text bold>{r.name}</Text>
            </Box>
            <Box key={`chips:${r.name}`} gap={2}>
              <Box key={`claude:${r.name}`}>
                <Text color={TONE[d.agent.tone]} bold={d.needs}>
                  {d.agent.label}
                </Text>
              </Box>
              {d.autonomous && (
                <Box key={`auto:${r.name}`}>
                  <Text>{d.autonomous.compact}</Text>
                </Box>
              )}
            </Box>
          </Box>
          {sub !== "" && (
            <Box key={`task:${r.name}`}>
              <Text>{sub}</Text>
            </Box>
          )}
          <Box key={`meta:${r.name}`}>
            <Text>{metaParts(d, polled !== undefined || prsPoll === "failed").map(part)}</Text>
          </Box>
          {vitals !== "" && (
            <Box key={`vitals:${r.name}`}>
              <Text dimColor>{vitals}</Text>
            </Box>
          )}
          {d.crash && (
            <Box key={`crash:${r.name}`}>
              <Text color={TONE.err}>{d.crash.text}</Text>
            </Box>
          )}
          {d.question && (
            <Box key={`question:${r.name}`}>
              <Text>
                <Text color="warning">{"▸ asked: "}</Text>
                <Text dimColor>{`“${d.question}”`}</Text>
              </Text>
            </Box>
          )}
          {r.services.map((svc, i) => {
            const row = snap?.intercepts.find(
              (x) => x.feature === r.feature && x.service === svc.name,
            );
            const c = interceptControl(svc.name, row, r.feature, snap);
            if (!c) return null;
            const glyph = d.services[i];
            const asking = confirm === `${INTERCEPT}${r.name}/${svc.name}`;
            const idle = busy !== r.name;
            return (
              <Box key={`svc:${r.name}/${svc.name}`} gap={1}>
                <Text>
                  <Text color={glyph ? TONE[glyph.tone] : undefined}>{glyph?.glyph ?? "●"}</Text>{" "}
                  {svc.name}
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
                      {`Intercept ${svc.name}? Installs a traffic-agent sidecar on ${row?.deployment ?? svc.name} in the shared dev cluster.${snap?.available ? "" : " Connects telepresence (docker) first."}`}
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
          {busy === r.name ? (
            <Box key={`busy:${r.name}`}>
              <Text dimColor>working…</Text>
            </Box>
          ) : confirming === "closeout" ? (
            <Box key={`confirm:${r.name}`} flexDirection="column" marginTop={1}>
              <Text color="error" bold>{`Close out ${r.name}?`}</Text>
              <Text dimColor>
                Issue → Done, closeout.md, workspace removed, merged branches deleted.
              </Text>
              <Box key={`confirm-buttons:${r.name}`} gap={1} marginTop={1}>
                <Button
                  key={`closeout:${r.name}`}
                  label="✓ Yes, close out"
                  variant="secondary"
                  onPress={() => void press($, "closeout", r.name)}
                />
                {button("cancel", "secondary")}
              </Box>
            </Box>
          ) : confirming === "abandon" ? (
            <Box key={`confirm:${r.name}`} flexDirection="column" marginTop={1}>
              <Text color="error" bold>{`✕ Abandon ${r.name}?`}</Text>
              <Text dimColor>Reason posted on the issue; workspace removed, branches kept.</Text>
              {Input && (
                <Input
                  key={`reason:${r.name}`}
                  placeholder="Why abandon? (required)"
                  value={reason}
                  submitLabel="save"
                  onInput={(v) => void $.state.set(REASON, v)}
                  onSubmit={(v) => void $.state.set(REASON, v)}
                />
              )}
              <Box key={`confirm-buttons:${r.name}`} gap={1} marginTop={1}>
                <Button
                  key={`abandon:${r.name}`}
                  label="✕ Yes, abandon"
                  variant="secondary"
                  onPress={() => void press($, "abandon", r.name)}
                />
                {button("cancel", "secondary")}
              </Box>
            </Box>
          ) : (
            <Box key={`actions:${r.name}`} flexDirection="column" marginTop={1}>
              {groups.map(([g, lines]) => (
                <Box key={`${g}-row:${r.name}`}>
                  <Box key={`${g}-label:${r.name}`} minWidth={11}>
                    <Text dimColor>{g}</Text>
                  </Box>
                  <Box key={`${g}-lines:${r.name}`} flexDirection="column">
                    {lines.map((line, i) => (
                      <Box key={`${g}-${i}:${r.name}`} flexWrap="wrap" gap={1}>
                        {line.map((a) => button(a))}
                      </Box>
                    ))}
                  </Box>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      );
    };

    return (
      <Box flexDirection="column">
        {tabs}
        <Box key="infra-bar" justifyContent="space-between" marginBottom={1}>
          <Box key="infra-col" flexDirection="column">
            <Box key="infra">
              <Text color={INFRA_COLOR[infra?.state ?? "unknown"]}>
                {infraLine(infra, tracker)}
              </Text>
            </Box>
            {host && (
              <Box key="host">
                <Text color={TONE[host.tone]}>{host.text}</Text>
              </Box>
            )}
          </Box>
          {busy === CONNECTING ? (
            <Box key="connecting">
              <Text dimColor>connecting…</Text>
            </Box>
          ) : (
            <Button
              key="connect"
              label="⚡ Connect infra"
              variant="secondary"
              onPress={() => void connect($)}
            />
          )}
        </Box>
        {legend && (
          <Box
            key="legend-box"
            flexDirection="column"
            borderStyle="round"
            borderColor="inactive"
            paddingX={1}
            marginBottom={1}
          >
            <Text bold>Legend</Text>
            <Text>
              <Text color="warning" bold>
                ● Needs you
              </Text>
              <Text dimColor>{"  agent asked you something; amber border = this, only this"}</Text>
            </Text>
            <Text>
              <Text color="success">◌ Working · ✓ Done</Text>
              <Text dimColor>{"  agent busy · agent finished"}</Text>
            </Text>
            <Text>
              <Text color="inactive">Idle</Text>
              <Text dimColor>{"  no live turn, nothing asked"}</Text>
            </Text>
            <Text>
              ⚙ Auto<Text dimColor>{"  autonomous run, no review gates until the PR"}</Text>
            </Text>
            <Text>
              <Text color="success">●</Text> <Text color="inactive">○</Text>{" "}
              <Text color="warning">◐</Text> <Text color="error">▲</Text>
              <Text dimColor>{"  service up · down · starting · unhealthy"}</Text>
            </Text>
            <Text>
              <Text color="success">green</Text> <Text color="warning">amber</Text>{" "}
              <Text color="error">red</Text> <Text color="inactive">grey</Text>
              <Text dimColor>{"  ok · partial or attention · failing · off"}</Text>
            </Text>
            <Text>
              <Text color="merged">Merged · Released</Text>
              <Text dimColor>{"  PR shipped"}</Text>
            </Text>
          </Box>
        )}
        {loadedRows === undefined && (
          <Text key="loading" dimColor>
            Loading workspaces…
          </Text>
        )}
        {loadedRows !== undefined && rows.length === 0 && <Text dimColor>No workspaces.</Text>}
        {shown.map(card)}
        {messages}
      </Box>
    );
  });
};
