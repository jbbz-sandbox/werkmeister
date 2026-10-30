/**
 * What a per-workspace token may call (SW-184): the verbs that act on one
 * workspace, all of which resolve it through lib/feature.ts and so refuse any
 * other. Host-wide tools (connect, proxy-reload, kube-switch, the PR sweep,
 * workspace creation, the Claude session tools…) stay machine-token only.
 */
export const WORKSPACE_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "up",
  "down",
  "stop",
  "pause",
  "resume",
  "restart",
  "services",
  "logs",
  "remove-service",
  "test",
  "intercept",
  "close-out",
  "init-workspace",
  "hooks",
  "notes",
  "skills",
  "workspace-pr",
  "workspace-usage",
  "status",
  "resources",
  "intercepts",
]);
