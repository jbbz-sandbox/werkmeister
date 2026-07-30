/**
 * Pure tree construction — every join, ownership, icon, and description decision
 * for the Sandbox Workspaces view.
 *
 * Deliberately free of any `vscode` import so it runs under `node --test`
 * without an extension harness; `tree.ts` does nothing but map a WsNode onto a
 * vscode.TreeItem. Input shapes are declared structurally rather than imported
 * from sandbox-driver, so the test file needs no driver build.
 */

export interface WorkspaceEntryLike {
  name: string;
  path: string;
  jiraId: string | null;
  jiraUrl: string | null;
  labels: string[];
}

export type ServiceHealthLike = "healthy" | "starting" | "unhealthy" | "running" | "down";

export interface WorkspaceStatusLike {
  name: string;
  project: string | null;
  state: "up" | "partial" | "stopped" | "down" | "unknown";
  running: number;
  total: number;
  slot: number | null;
  ports: string | null;
  services: { name: string; state: ServiceHealthLike }[];
}

export interface InterceptRowLike {
  interceptable: boolean;
  blocker: string | null;
  intercepted: boolean;
  intercepted_by: string | null;
}

export interface InterceptsLike {
  available: boolean;
  byFeature: Map<string, Map<string, InterceptRowLike>>;
}

export interface WsNode {
  kind: "workspace" | "service" | "error";
  /** Stable across refreshes so VS Code preserves expansion state. */
  id: string;
  label: string;
  description: string;
  tooltip: string;
  icon: { id: string; color?: string };
  contextValue: string;
  expanded: boolean;
  workspace?: { name: string; path: string; feature: string | null; jiraUrl: string | null };
  service?: { name: string; workspacePath: string; feature: string | null; leave: boolean };
  /** Command id to run when the node is clicked, if any. */
  command?: string;
  children: WsNode[];
}

/**
 * Feature name from a Compose project name. `getWorkspaceStatuses` sets
 * `project` from the workspace's `COMPOSE_PROJECT_NAME`, which `init-workspace`
 * always writes as `sandbox-<feature>` (and falls back to that same form), so
 * stripping the prefix is the reliable inverse.
 *
 * ponytail: prefix strip rather than re-reading .sandbox/workspace.yml per
 * workspace. If a hand-edited .env ever breaks the convention, read the yml.
 */
export function featureOf(project: string | null): string | null {
  if (!project || !project.startsWith("sandbox-")) return null;
  return project.slice("sandbox-".length) || null;
}

const WORKSPACE_ICONS: Record<WorkspaceStatusLike["state"], { id: string; color?: string }> = {
  up: { id: "circle-filled", color: "charts.green" },
  partial: { id: "circle-filled", color: "charts.yellow" },
  stopped: { id: "circle-outline", color: "descriptionForeground" },
  down: { id: "circle-outline", color: "descriptionForeground" },
  unknown: { id: "question", color: "descriptionForeground" },
};

const SERVICE_ICONS: Record<ServiceHealthLike, { id: string; color?: string }> = {
  healthy: { id: "pass", color: "charts.green" },
  starting: { id: "loading~spin" },
  unhealthy: { id: "warning", color: "charts.red" },
  running: { id: "circle-filled", color: "charts.blue" },
  down: { id: "circle-outline", color: "descriptionForeground" },
};

/** True when `child` is `parent` or sits inside it. Segment-aware: /ws/ab is not an ancestor of /ws/abc. */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith("/") ? parent : parent + "/";
  return child.startsWith(withSep);
}

/**
 * The workspace whose directory is, or contains, the open folder. When several
 * match (one workspace nested inside another) the deepest wins, since that is
 * the one the user is actually in.
 */
function currentWorkspaceName(
  workspaces: WorkspaceEntryLike[],
  currentPath: string | null,
): string | null {
  if (!currentPath) return null;
  let best: WorkspaceEntryLike | null = null;
  for (const w of workspaces) {
    if (!contains(w.path, currentPath)) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  return best?.name ?? null;
}

/**
 * Display state for one service's intercept. Mirrors the driver's
 * `interceptFields`, but returns the presentation triple the tree needs. A
 * missing row is disabled-and-explained rather than hidden, and a failed lookup
 * is distinguished from "not interceptable" — the two mean different things and
 * only one of them is worth investigating.
 */
export function interceptView(
  row: InterceptRowLike | undefined,
  feature: string | null,
  lookupFailed: boolean,
): { contextValue: string; note: string; leave: boolean } {
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
  return { contextValue: "service:interceptable", note: "interceptable", leave: false };
}

function serviceNode(
  svc: { name: string; state: ServiceHealthLike },
  ws: WorkspaceEntryLike,
  feature: string | null,
  intercepts: InterceptsLike | null,
): WsNode {
  const row = feature ? intercepts?.byFeature.get(feature)?.get(svc.name) : undefined;
  const view = interceptView(row, feature, intercepts === null);
  const suffix =
    view.contextValue === "service:intercepted-mine"
      ? " · intercepted (yours)"
      : view.contextValue === "service:intercepted-other"
        ? " · intercepted"
        : "";
  return {
    kind: "service",
    id: `${ws.name}/${svc.name}`,
    label: svc.name,
    description: `${svc.state}${suffix}`,
    tooltip: `${svc.name} — ${svc.state}\n${view.note}`,
    icon: SERVICE_ICONS[svc.state] ?? SERVICE_ICONS.down,
    contextValue: view.contextValue,
    expanded: false,
    service: { name: svc.name, workspacePath: ws.path, feature, leave: view.leave },
    children: [],
  };
}

function workspaceNode(
  ws: WorkspaceEntryLike,
  status: WorkspaceStatusLike | undefined,
  intercepts: InterceptsLike | null,
  isCurrent: boolean,
): WsNode {
  const state = status?.state ?? "unknown";
  const feature = featureOf(status?.project ?? null);

  const bits: string[] = [];
  if (isCurrent) bits.push("current");
  if (state === "unknown") bits.push("unknown");
  else if (status && status.total > 0) bits.push(`${status.running}/${status.total}`);
  else bits.push("down");
  if (status?.slot != null) bits.push(`slot ${status.slot}`);
  if (ws.jiraId) bits.push(ws.jiraId);

  const tip = [
    ws.path,
    status?.project ? `compose project: ${status.project}` : null,
    status?.ports ? `ports: ${status.ports}` : null,
    ws.labels.length ? `labels: ${ws.labels.join(", ")}` : null,
  ].filter((l): l is string => l !== null);

  return {
    kind: "workspace",
    id: ws.name,
    label: ws.name,
    description: bits.join(" · "),
    tooltip: tip.join("\n"),
    icon: WORKSPACE_ICONS[state],
    contextValue: `workspace:${state}`,
    expanded: isCurrent,
    workspace: { name: ws.name, path: ws.path, feature, jiraUrl: ws.jiraUrl },
    children: (status?.services ?? []).map((s) => serviceNode(s, ws, feature, intercepts)),
  };
}

/**
 * Build the whole tree from the three driver payloads.
 *
 * The workspace list is authoritative: maps over `workspaces`, joining with
 * `statuses` by name. A workspace with no matching status renders as `unknown`;
 * a status with no matching workspace is ignored.
 */
export function buildTree(
  workspaces: WorkspaceEntryLike[],
  statuses: WorkspaceStatusLike[],
  intercepts: InterceptsLike | null,
  currentPath: string | null,
): WsNode[] {
  const byName = new Map(statuses.map((s) => [s.name, s]));
  const current = currentWorkspaceName(workspaces, currentPath);
  return workspaces.map((w) => workspaceNode(w, byName.get(w.name), intercepts, w.name === current));
}

/** The single node shown when the CLI can't be located — never an empty view. */
export function cliNotFoundNode(message: string): WsNode {
  return {
    kind: "error",
    id: "error:cli-not-found",
    label: "Could not find the sandbox CLI",
    description: "click to configure",
    tooltip: `${message}\n\nSet sandbox.binPath or sandbox.root, or run \`sandbox config\`.`,
    icon: { id: "error", color: "charts.red" },
    contextValue: "error",
    expanded: false,
    command: "sandbox.configure",
    children: [],
  };
}
