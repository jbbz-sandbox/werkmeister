/**
 * Pure tree construction — every join, ownership, icon, and description decision
 * for the Werkmeister Workspaces view.
 *
 * Deliberately free of any `vscode` import so it runs under `node --test`
 * without an extension harness; `tree.ts` does nothing but map a WsNode onto a
 * vscode.TreeItem. Words, tones and glyphs come from werkmeister-ui's display
 * model (SW-49), shared with the pane and the React card, so they are never
 * re-derived here; this file only maps tones to VS Code theme colours.
 */

import {
  type DisplayInput,
  type DisplayOptions,
  displayModel,
  type HostInput,
  needLine,
  type PrInput,
  type ServiceHealth,
  type StatusStrip,
  type StripGlobals,
  statusStrip,
  type Tone,
  type UsageInput,
  type WorkspaceDisplay,
} from "werkmeister-ui";

export interface WorkspaceEntryLike {
  name: string;
  path: string;
  issueId: string | null;
  issueUrl: string | null;
  labels: string[];
}

export type ServiceHealthLike = ServiceHealth;

/**
 * Each workspace's PR files (`lifecycleOf().prs`) as one string: it changes when `pr open` records
 * a URL or a PR file's status moves, so the view refetches PRs then, not only on ↻ (SW-818).
 */
export function prFilesKey(
  prs: Map<string, { dir: string; status: string; url: string | null }[]>,
): string {
  return JSON.stringify(
    [...prs].map(([ws, files]) => [ws, files.map((f) => [f.dir, f.status, f.url])]),
  );
}

export interface WorkspaceStatusLike extends DisplayInput {
  name: string;
  project: string | null;
  slot: number | null;
  ports: string | null;
}

/** What the tree knows beyond the status sweep. */
export interface TreeExtras {
  /** Per workspace name. Undefined until the first `getWorkspacePRs` lands; null when it failed. */
  prs?: Map<string, PrInput[]> | null;
  /** Per workspace name, from the same fetch: what its PRs need and the phase note (SW-558). */
  prNeeds?: Map<string, Pick<DisplayOptions, "prNeeds" | "phaseDetail">>;
  lifecycles?: Map<string, DisplayOptions["lifecycle"]>;
  now?: Date;
  /** Per compose project, from the slower resources sweep; undefined until it lands. */
  usage?: Record<string, UsageInput> | null;
  /** For the strip. Undefined: no sweep yet, so no host line. Null: the sweep failed. */
  host?: HostInput | null;
  /** The shared infra stack, from the same `status` call as the rows. */
  infra?: StripGlobals["infra"];
}

export interface WsCard {
  /** `◌ Working`; coloured like the node's icon. */
  state: string;
  /** `Thinking · 25 min ago`, with its theme colour id. */
  activity: { text: string; color: string } | null;
  /** `Stage 2 of 4 · spec`, `PR open · waiting on review`. */
  phase: string | null;
  /** The Needs you list, one `● <what> · <since> — <action>` line each, as the pane shows it. */
  needs: string[];
  crash: string | null;
  /** Model, autonomy, `stage 2/4 implement`, CPU and memory. */
  meta: string;
  /** One entry per ICM stage (SW-961); empty for JIT, unstaged, finished or lifecycle workspaces. */
  pips: WorkspaceDisplay["workflow"]["pips"];
  issueId: string | null;
  /** The agent asked something: the strip counts it and the card's button reads Answer in terminal. */
  needsYou: boolean;
  /** The one session button the card shows, if any (`sessionAction`). */
  action: "start" | "pause" | "resume" | null;
  /** Lifecycle `merged`: the PR merged and no release has it yet (SW-1003). */
  waitingRelease: boolean;
}

export interface InterceptRowLike {
  interceptable: boolean;
  blocker: string | null;
  intercepted: boolean;
  intercepted_by: string | null;
}

export interface InterceptsLike {
  available: boolean;
  /** On PATH, connected or not: a disconnected install is still interceptable (SW-12). */
  installed: boolean;
  byFeature: Map<string, Map<string, InterceptRowLike>>;
  remoteServices: ReadonlySet<string>;
}

export interface WsNode {
  kind: "workspace" | "service" | "pr" | "legend" | "error";
  /** Stable across refreshes so VS Code preserves expansion state. */
  id: string;
  label: string;
  description: string;
  /** Markdown on a workspace node, plain text elsewhere. */
  tooltip: string;
  icon: { id: string; color?: string };
  /** A service's `●`/`○`/`◐`/`▲`: the cards have no codicon font. */
  glyph?: string;
  /** The wrapping lines of a workspace's card (cards.ts); absent on every other kind. */
  card?: WsCard;
  contextValue: string;
  expanded: boolean;
  workspace?: {
    name: string;
    path: string;
    feature: string | null;
    issueUrl: string | null;
    prs: { ref: string; url: string }[];
  };
  service?: { name: string; workspacePath: string; feature: string | null; leave: boolean };
  /** `status`: the state word and the CI word, each with its theme colour id, for the card. */
  pr?: { url: string; open?: boolean; status?: { text: string; color: string }[] };
  /** Command id to run when the node is clicked, if any. */
  command?: string;
  children: WsNode[];
}

/**
 * Feature name from a Compose project name. `getWorkspaceStatuses` sets
 * `project` from the workspace's `COMPOSE_PROJECT_NAME`, which `init-workspace`
 * always writes as `werkmeister-<feature>`, so stripping the prefix is the reliable inverse.
 *
 * ponytail: prefix strip rather than re-reading .werkmeister/workspace.yml per
 * workspace. If a hand-edited .env ever breaks the convention, read the yml.
 */
export function featureOf(project: string | null): string | null {
  return (project?.startsWith("werkmeister-") && project.slice("werkmeister-".length)) || null;
}

/** Board 09 §E. `needs` is a solid chip elsewhere; a tree icon can only be yellow. */
export const TONE_COLORS: Record<Tone, string> = {
  ok: "charts.green",
  warn: "charts.yellow",
  err: "errorForeground",
  off: "disabledForeground",
  pr: "charts.purple",
  needs: "charts.yellow",
};

/** The only commands a workspace tooltip may link to; tree.ts trusts exactly these. */
export const TOOLTIP_COMMANDS = [
  "sandbox.continue",
  "sandbox.closeOut",
  "sandbox.up",
  "sandbox.resume",
  "sandbox.switch",
  "sandbox.openFeature",
];

const PRIMARY_COMMAND: Record<WorkspaceDisplay["primary"]["action"], string> = {
  continue: "sandbox.continue",
  "close-out": "sandbox.closeOut",
  up: "sandbox.up",
  resume: "sandbox.resume",
};

/**
 * Board 09 §F as tree rows, toggled by the view's `?`. Rows rather than
 * `TreeView.message`, which VS Code sets as plain textContent: no line breaks,
 * no codicons, no colour.
 */
export const LEGEND_NODE: WsNode = legendGroup([
  ["circle-filled", "needs", "Needs you", "the agent asked you something"],
  ["sync", "ok", "Working", "agent busy"],
  ["pass", "ok", "Done", "agent finished"],
  ["circle-outline", "off", "Idle", "no live turn, nothing asked"],
  ["debug-pause", "off", "Paused", "session held, containers frozen · ▶ Resume"],
  ["warning", "err", "▲ unhealthy", "service · ● up · ○ down · ◐ starting"],
  ["git-merge", "pr", "Merged · Released", "PR state · Open is green"],
  ["gear", "off", "⚙ Auto", "autonomous run"],
]);

function legendGroup(rows: [string, Tone, string, string][]): WsNode {
  const leaf = { contextValue: "legend", expanded: false, children: [] };
  return {
    ...leaf,
    kind: "legend",
    id: "legend:",
    label: "Legend",
    description: "icon colour follows the agent",
    tooltip: "Icon colour follows the agent. The state word is always in the description.",
    icon: { id: "question" },
    expanded: true,
    children: rows.map(([id, tone, label, description]) => ({
      ...leaf,
      kind: "legend",
      id: `legend:${label}`,
      label,
      description,
      tooltip: `${label}: ${description}`,
      icon: { id, color: TONE_COLORS[tone] },
    })),
  };
}

/** Hovers render Markdown, so names, labels and the agent's question must not inject any. */
function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

function commandLink(label: string, command: string, ws: WorkspaceEntryLike): string {
  // pickWorkspace() reads only `workspace.name` / `workspace.path` off its argument.
  const arg = encodeURIComponent(JSON.stringify([{ workspace: { name: ws.name, path: ws.path } }]));
  return `[${escapeMd(label)}](command:${command}?${arg})`;
}

/** True when `child` is `parent` or sits inside it. Segment-aware: /ws/ab is not an ancestor of /ws/abc. */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith("/") ? parent : parent + "/";
  return child.startsWith(withSep);
}

/**
 * The workspace whose directory is, or contains, one of the window's open
 * folders. Folders are searched in order, because `sandbox.switch` puts the
 * workspace you switched to first and that is the one Claude Code reads
 * CLAUDE.md from — but later folders still count, since a multi-root
 * `.code-workspace` can list a tooling checkout ahead of the feature workspace.
 * Within one folder, the deepest match wins (one workspace nested in another).
 */
function currentWorkspaceName(
  workspaces: Pick<WorkspaceEntryLike, "name" | "path">[],
  currentPaths: string[],
): string | null {
  for (const p of currentPaths) {
    let best: Pick<WorkspaceEntryLike, "name" | "path"> | null = null;
    for (const w of workspaces) {
      if (!contains(w.path, p)) continue;
      if (!best || w.path.length > best.path.length) best = w;
    }
    if (best) return best.name;
  }
  return null;
}

/** The workspaces-root chat's terminal name (SW-1009: was Master control). */
export const FOREMAN = "Foreman";

/** Terminals opened before the rename keep their old name, so both still count as Foreman's. */
export function isForemanTerminal(name: string): boolean {
  return name.includes(FOREMAN) || name.includes("Master control");
}

/** Which tile the active terminal is showing (SW-864): a workspace's card, the root chat, or neither. */
export type InTerminal = { kind: "workspace"; name: string } | { kind: "root" } | null;

/**
 * Map the active terminal's cwd to a tile. A session terminal starts in its workspace's
 * folder and Foreman at the workspaces root; any other cwd, or none, shows no cue.
 */
export function inTerminal(
  workspaces: Pick<WorkspaceEntryLike, "name" | "path">[],
  cwd: string | undefined,
  root: string,
): InTerminal {
  if (!cwd) return null;
  const name = currentWorkspaceName(workspaces, [cwd]);
  if (name) return { kind: "workspace", name };
  const trim = (p: string) => p.replace(/\/+$/, "");
  return trim(cwd) === trim(root) ? { kind: "root" } : null;
}

/**
 * The Jira board link for the title bar: the default project's board, else nothing.
 * Only a Jira project with a board id gets one; the icon hides rather than guess.
 */
export function boardUrl(
  base: string | undefined,
  projects: {
    tracker: string;
    scope: { project?: string };
    board?: { id: string };
    default: boolean;
  }[],
): string | null {
  const p = projects.find((x) => x.default) ?? (projects.length === 1 ? projects[0] : undefined);
  if (!base || p?.tracker !== "jira" || !p.scope.project || !p.board) return null;
  const key = encodeURIComponent(p.scope.project);
  return `${base.replace(/\/+$/, "")}/jira/software/projects/${key}/boards/${encodeURIComponent(p.board.id)}`;
}

/**
 * Display state for one service's intercept. Mirrors werkmeister-core's
 * `interceptFields`, but returns the presentation triple the tree needs. A
 * missing row is disabled-and-explained rather than hidden, and a failed lookup
 * is distinguished from "not interceptable" — the two mean different things and
 * only one of them is worth investigating. Null for a service that is never a
 * cluster service (a CLI, a library): intercepting has no meaning there (SW-21).
 */
export function interceptView(
  row: InterceptRowLike | undefined,
  feature: string | null,
  lookupFailed: boolean,
  remote: boolean,
  connected = true,
): { contextValue: string; note: string; leave: boolean } | null {
  if (!remote) return null;
  if (!row) {
    return {
      contextValue: "service",
      note: lookupFailed
        ? "intercept state unavailable"
        : "not an interceptable service of this workspace",
      leave: false,
    };
  }
  if (row.intercepted) {
    // Only one intercept exists per Deployment, so another feature's intercept
    // must never offer a --leave — it would fail.
    const mine = row.intercepted_by === feature && feature !== null;
    return mine
      ? { contextValue: "service:intercepted-mine", note: "intercepted (yours)", leave: true }
      : {
          contextValue: "service:intercepted-other",
          note: `intercepted by feature '${row.intercepted_by ?? "unknown"}' — one intercept per deployment`,
          leave: false,
        };
  }
  if (!row.interceptable) {
    return { contextValue: "service", note: row.blocker ?? "not interceptable", leave: false };
  }
  return {
    contextValue: "service:interceptable",
    note: connected ? "interceptable" : "interceptable (telepresence not connected)",
    leave: false,
  };
}

function serviceNode(
  svc: { name: string; state: ServiceHealthLike },
  ws: WorkspaceEntryLike,
  feature: string | null,
  intercepts: InterceptsLike | null,
  look: { codicon: string; tone: Tone; glyph: string },
): WsNode {
  const row = feature ? intercepts?.byFeature.get(feature)?.get(svc.name) : undefined;
  // A failed lookup can't tell remote from local, so it keeps "unavailable" on every row.
  const view = interceptView(
    row,
    feature,
    intercepts === null || !intercepts.installed,
    intercepts?.remoteServices.has(svc.name) ?? true,
    intercepts?.available ?? true,
  );
  const suffix =
    view?.contextValue === "service:intercepted-mine"
      ? " · intercepted (yours)"
      : view?.contextValue === "service:intercepted-other"
        ? " · intercepted"
        : "";
  return {
    kind: "service",
    id: `${ws.name}/${svc.name}`,
    label: svc.name,
    description: `${svc.state}${suffix}`,
    tooltip: view ? `${svc.name} — ${svc.state}\n${view.note}` : `${svc.name} — ${svc.state}`,
    icon: {
      id: look.codicon === "loading" ? "loading~spin" : look.codicon,
      color: TONE_COLORS[look.tone],
    },
    glyph: look.glyph,
    contextValue: view?.contextValue ?? "service",
    expanded: false,
    service: { name: svc.name, workspacePath: ws.path, feature, leave: view?.leave ?? false },
    children: [],
  };
}

/** The display model gives Merged and Released one tone; the card tells a release apart in blue. */
export const RELEASED_COLOR = "charts.blue";

function prStateColor(state: { text: string; tone: Tone }): string {
  return state.text.startsWith("Released") ? RELEASED_COLOR : TONE_COLORS[state.tone];
}

function prNode(ws: WorkspaceEntryLike, pr: WorkspaceDisplay["prs"][number]): WsNode {
  return {
    kind: "pr",
    id: `${ws.name}/pr/${pr.url}`,
    label: pr.ref,
    description: [pr.state.text, pr.ci?.text].filter(Boolean).join(" · "),
    tooltip: pr.url,
    icon: {
      id: pr.state.tone === "pr" ? "git-merge" : "git-pull-request",
      color: TONE_COLORS[pr.state.tone],
    },
    contextValue: "pr",
    expanded: false,
    pr: {
      url: pr.url,
      // The display model's word for an open, non-draft PR: one waiting on review.
      open: pr.state.text === "Open",
      status: [
        { text: pr.state.text, color: prStateColor(pr.state) },
        ...(pr.ci ? [{ text: pr.ci.text, color: TONE_COLORS[pr.ci.tone] }] : []),
      ],
    },
    command: "sandbox.openPr",
    children: [],
  };
}

/**
 * The card's one button acts on the run, not on containers: start it, hold it, or pick it back up.
 * Start is the pane's ▶ Start work rule (SW-153) without its session list: no turn ever signalled
 * and the first stage at most. Pause is offered while there is something to hold.
 */
export function sessionAction(s: WorkspaceStatusLike): "start" | "pause" | "resume" | null {
  if (s.state === "paused") return "resume";
  const agent = s.workspaceState?.agent ?? { id: "idle", since: null };
  if (agent.id === "idle" && !agent.since && !s.lastActivity && (s.stage?.index ?? 1) === 1)
    return "start";
  if (
    agent.id === "working" ||
    agent.id === "needs-you" ||
    s.state === "up" ||
    s.state === "partial"
  )
    return "pause";
  return null;
}

function needLines(d: WorkspaceDisplay): string[] {
  return d.needsList.map(needLine);
}

/** The card's rows as a hover: Containers / PRs / Workflow / Agent, the question, then actions. */
function workspaceTooltip(
  ws: WorkspaceEntryLike,
  status: WorkspaceStatusLike | undefined,
  d: WorkspaceDisplay | null,
): string {
  const issue = ws.issueId
    ? ws.issueUrl
      ? `[${escapeMd(ws.issueId)}](${ws.issueUrl})`
      : escapeMd(ws.issueId)
    : "no issue";
  const blocks = [`**${escapeMd(ws.name)}**  \n${issue}`];
  if (d) {
    const services = d.services.map((s) => s.text).join(" · ");
    const prs = d.prsEmpty
      ? d.prsEmpty.text
      : d.prs
          .map((p) => [`${p.ref} ${p.state.text}`, p.ci?.text].filter(Boolean).join(" · "))
          .join("; ");
    const agent = [d.agent.label, d.autonomous?.full, d.agent.time].filter(Boolean).join(" · ");
    const resources = [d.usage?.text, d.started?.text].filter(Boolean).join(" · ");
    blocks.push(
      [
        `**Containers** ${escapeMd(d.containers.text + (services ? ` — ${services}` : ""))}`,
        ...(resources ? [`**Resources** ${escapeMd(resources)}`] : []),
        ...(d.crash ? [`**Crash** ${escapeMd(d.crash.text)}`] : []),
        `**PRs** ${escapeMd(prs)}`,
        `**Workflow** ${escapeMd(d.workflow.text || "—")}`,
        `**Agent** ${escapeMd(agent)}`,
      ].join("  \n"),
    );
    for (const n of needLines(d)) blocks.push(`> ${escapeMd(n)}`);
    blocks.push(
      [
        commandLink(d.primary.label, PRIMARY_COMMAND[d.primary.action], ws),
        commandLink("→ Switch to", "sandbox.switch", ws),
        commandLink("Open feature ↗", "sandbox.openFeature", ws),
      ].join(" · "),
    );
  }
  const footer = [
    `\`${ws.path}\``,
    status?.slot != null
      ? escapeMd(`slot ${status.slot}${status.ports ? ` (${status.ports})` : ""}`)
      : null,
    status?.project ? escapeMd(`compose project ${status.project}`) : null,
    ws.labels.length ? escapeMd(`labels: ${ws.labels.join(", ")}`) : null,
  ].filter((l): l is string => l !== null);
  blocks.push(footer.join(" · "));
  return blocks.join("\n\n");
}

function workspaceNode(
  ws: WorkspaceEntryLike,
  status: WorkspaceStatusLike | undefined,
  intercepts: InterceptsLike | null,
  isCurrent: boolean,
  extra: TreeExtras,
): WsNode {
  const state = status?.state ?? "unknown";
  const feature = featureOf(status?.project ?? null);
  const prs = extra.prs && (extra.prs.get(ws.name) ?? []);
  const d = status
    ? displayModel(status, {
        prs,
        lifecycle: extra.lifecycles?.get(ws.name) ?? null,
        // VS Code can't reach desktop sessions (ui-spec § Actions).
        where: "Terminal",
        now: extra.now,
        usage: status.project ? extra.usage?.[status.project] : null,
        ...extra.prNeeds?.get(ws.name),
      })
    : null;

  // The design drops the stage name to keep the row short; the tooltip spells it out.
  const workflow =
    d?.workflow.kind === "icm" && status?.stage
      ? `stage ${status.stage.index}/${status.stage.total}`
      : d?.workflow.compact;
  const bits = [
    isCurrent ? "current" : "",
    ...(d ? [d.agent.label, d.containers.text, d.usage?.text ?? "", workflow ?? ""] : ["unknown"]),
    ws.issueId ?? "",
    d?.autonomous?.compact ?? "",
  ].filter(Boolean);

  return {
    kind: "workspace",
    id: ws.name,
    label: ws.name,
    description: bits.join(" · "),
    tooltip: workspaceTooltip(ws, status, d),
    // The icon follows the agent (design data.js `AGENT.vs`); the container state is in the words.
    icon: d
      ? {
          id: d.agent.codicon + (status?.workspaceState?.agent?.id === "working" ? "~spin" : ""),
          color: TONE_COLORS[d.agent.dot],
        }
      : { id: "question", color: TONE_COLORS.off },
    card: {
      state: d?.agent.label ?? "unknown",
      activity: d?.activity
        ? {
            text: [d.activity.text, d.activity.time].filter(Boolean).join(" · "),
            color: TONE_COLORS[d.activity.tone],
          }
        : null,
      // While building, the phase is the stage, which meta already shows.
      phase: status?.workspaceState?.phase.id === "building" ? null : d?.phase?.text || null,
      needs: d ? needLines(d) : [],
      crash: d?.crash?.text ?? null,
      // The card has the room the row lacked, so the stage keeps its name here.
      meta: [
        isCurrent ? "current" : "",
        d?.model ?? "",
        d?.autonomous?.compact ?? "",
        d?.workflow.compact ?? "",
        d?.usage?.text ?? "",
        // The service line already says what is up; without one, the count does.
        status?.services.length ? "" : (d?.containers.text ?? ""),
      ]
        .filter(Boolean)
        .join(" · "),
      pips: d?.workflow.pips ?? [],
      issueId: ws.issueId,
      needsYou: status?.workspaceState?.agent?.id === "needs-you",
      action: status ? sessionAction(status) : null,
      waitingRelease: extra.lifecycles?.get(ws.name) === "merged",
    },
    // The `:current` suffix is how the menus hide "switch to workspace" on the
    // window's own workspace; every workspace `when` regex tolerates it.
    contextValue: `workspace:${state}${isCurrent ? ":current" : ""}`,
    expanded: isCurrent,
    workspace: {
      name: ws.name,
      path: ws.path,
      feature,
      issueUrl: ws.issueUrl,
      prs: (d?.prs ?? []).map((p) => ({ ref: p.ref, url: p.url })),
    },
    children: [
      ...(status && d
        ? status.services.map((s, i) => serviceNode(s, ws, feature, intercepts, d.services[i]))
        : []),
      ...(d?.prs ?? []).map((p) => prNode(ws, p)),
    ],
  };
}

/**
 * Build the whole tree from the werkmeister-core payloads.
 *
 * The workspace list is authoritative: maps over `workspaces`, joining with
 * `statuses` by name. A workspace with no matching status renders as `unknown`;
 * a status with no matching workspace is ignored.
 */
export function buildTree(
  workspaces: WorkspaceEntryLike[],
  statuses: WorkspaceStatusLike[],
  intercepts: InterceptsLike | null,
  currentPaths: string[],
  extra: TreeExtras = {},
): WsNode[] {
  const byName = new Map(statuses.map((s) => [s.name, s]));
  const current = currentWorkspaceName(workspaces, currentPaths);
  const nodes = workspaces.map((w) =>
    workspaceNode(w, byName.get(w.name), intercepts, w.name === current, extra),
  );
  // The window's own workspace first; the rest keep werkmeister-core's name order.
  const i = nodes.findIndex((n) => n.id === current);
  if (i > 0) nodes.unshift(...nodes.splice(i, 1));
  return nodes;
}

/**
 * The pinned strip (SW-1009): the shared model over the same rows, in card order, so a chip
 * jumps to the first card it counts.
 */
export function stripOf(
  nodes: WsNode[],
  statuses: WorkspaceStatusLike[],
  extra: TreeExtras = {},
): StatusStrip {
  const byName = new Map(statuses.map((s) => [s.name, s]));
  const rows = nodes.flatMap((n) => {
    const ws = n.kind === "workspace" ? byName.get(n.id) : undefined;
    return ws
      ? [{ name: n.id, ws, prs: extra.prs?.get(n.id), prNeeds: extra.prNeeds?.get(n.id)?.prNeeds }]
      : [];
  });
  return statusStrip(rows, { host: extra.host, infra: extra.infra }, extra.now);
}

/** The single node shown when the CLI can't be located — never an empty view. */
/** The host daemon is not answering: every Docker read in the view goes through it (SW-184). */
export function daemonDownNode(message: string): WsNode {
  return {
    kind: "error",
    id: "error:daemon-down",
    label: "werkmeister daemon not running",
    description: "run werkmeister machine setup or connect",
    tooltip: message,
    icon: { id: "error", color: TONE_COLORS.err },
    contextValue: "error",
    expanded: false,
    children: [],
  };
}

export function cliNotFoundNode(message: string): WsNode {
  return {
    kind: "error",
    id: "error:cli-not-found",
    label: "Could not find the werkmeister CLI",
    description: "click to configure",
    tooltip: `${message}\n\nSet sandbox.binPath or sandbox.root, or run \`werkmeister machine config\`.`,
    icon: { id: "error", color: TONE_COLORS.err },
    contextValue: "error",
    expanded: false,
    command: "sandbox.configure",
    children: [],
  };
}
