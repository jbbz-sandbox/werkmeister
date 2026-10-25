/**
 * Pure tree construction — every join, ownership, icon, and description decision
 * for the Sandbox Workspaces view.
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
  hostLine,
  type PrInput,
  type ServiceHealth,
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
  lifecycles?: Map<string, DisplayOptions["lifecycle"]>;
  now?: Date;
  /** Per compose project, from the slower resources sweep; undefined until it lands. */
  usage?: Record<string, UsageInput> | null;
  /** Undefined: no sweep yet, so no host row. Null: the sweep failed. */
  host?: HostInput | null;
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
  kind: "workspace" | "service" | "pr" | "legend" | "host" | "error";
  /** Stable across refreshes so VS Code preserves expansion state. */
  id: string;
  label: string;
  description: string;
  /** Markdown on a workspace node, plain text elsewhere. */
  tooltip: string;
  icon: { id: string; color?: string };
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
  pr?: { url: string };
  /** Command id to run when the node is clicked, if any. */
  command?: string;
  children: WsNode[];
}

/**
 * Feature name from a Compose project name. `getWorkspaceStatuses` sets
 * `project` from the workspace's `COMPOSE_PROJECT_NAME`, which `init-workspace`
 * always writes as `werkmeister-<feature>` (`sandbox-<feature>` before SW-93,
 * read until SW-11), so stripping the prefix is the reliable inverse.
 *
 * ponytail: prefix strip rather than re-reading .sandbox/workspace.yml per
 * workspace. If a hand-edited .env ever breaks the convention, read the yml.
 */
export function featureOf(project: string | null): string | null {
  const prefix = ["werkmeister-", "sandbox-"].find((p) => project?.startsWith(p));
  return (prefix && project?.slice(prefix.length)) || null;
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
  workspaces: WorkspaceEntryLike[],
  currentPaths: string[],
): string | null {
  for (const p of currentPaths) {
    let best: WorkspaceEntryLike | null = null;
    for (const w of workspaces) {
      if (!contains(w.path, p)) continue;
      if (!best || w.path.length > best.path.length) best = w;
    }
    if (best) return best.name;
  }
  return null;
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
  look: { codicon: string; tone: Tone },
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
    contextValue: view?.contextValue ?? "service",
    expanded: false,
    service: { name: svc.name, workspacePath: ws.path, feature, leave: view?.leave ?? false },
    children: [],
  };
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
    pr: { url: pr.url },
    command: "sandbox.openPr",
    children: [],
  };
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
    if (d.question) blocks.push(`> “${escapeMd(d.question)}”`);
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
          id: d.agent.codicon + (status?.claude.agent === "working" ? "~spin" : ""),
          color: TONE_COLORS[d.agent.dot],
        }
      : { id: "question", color: TONE_COLORS.off },
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
  return extra.host === undefined ? nodes : [hostNode(extra.host), ...nodes];
}

/** The load line above the workspaces (SW-41). */
function hostNode(host: HostInput | null): WsNode {
  const line = hostLine(host);
  return {
    kind: "host",
    id: "host:",
    label: "Host",
    description: line.text.replace(/^host /, ""),
    tooltip: `${line.text}\nLoad average (1 · 5 · 15 min) and the CPU of every feature container, in % of one core.`,
    icon: { id: "pulse", color: TONE_COLORS[line.tone] },
    contextValue: "host",
    expanded: false,
    children: [],
  };
}

/** The single node shown when the CLI can't be located — never an empty view. */
export function cliNotFoundNode(message: string): WsNode {
  return {
    kind: "error",
    id: "error:cli-not-found",
    label: "Could not find the sandbox CLI",
    description: "click to configure",
    tooltip: `${message}\n\nSet sandbox.binPath or sandbox.root, or run \`sandbox config\`.`,
    icon: { id: "error", color: TONE_COLORS.err },
    contextValue: "error",
    expanded: false,
    command: "sandbox.configure",
    children: [],
  };
}
