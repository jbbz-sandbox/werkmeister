# Infra Health tab — design

**Date:** 2026-07-14
**Status:** Approved (pending spec review)
**Surface:** sandbox MCP workspace browser dashboard (`apps/mcp-workspace`)

## Goal

Add a fourth tab, **"Health"**, to the browser dashboard. It's the detail view for
sandbox infra health: per-container status for the shared infra stack, per-forward
status for the default GKE port-forwards, and the current kubectl context with a
switch-back-to-dev control. The existing top-bar chips (aggregate infra/GKE/kube
summary in `workspace-ui.ts`'s `initTopBar()`) stay as-is for at-a-glance status —
this tab is where you click in for the itemized breakdown.

## Non-goals

- Docker healthcheck parsing (`healthy`/`unhealthy`/`starting`). Scope is
  running-vs-stopped per container, matching what `docker ps`'s `.State` field
  already gives us with no new query. A later pass can add `.Status` parsing if
  running-but-unhealthy containers turn out to be a real failure mode worth
  surfacing.
- Auto-refresh / polling. Manual refresh only, matching the existing top-bar
  click-to-recheck pattern.
- Per-workspace (per-feature) service breakdown. `workspace-ui.ts`'s existing list
  already shows per-workspace up/partial/stopped/down; this tab is shared-infra +
  GKE + kube only.
- Explicit "Switch to stage" / "Switch to prod" buttons. Only "Switch to dev" is
  needed — matches `kube-switch`'s existing default and the ask (a way back to dev
  if context drifts).
- Removing or collapsing the top-bar chips. They remain the quick-glance summary.

## Backend changes

### Extend `dockerComposeProjects()` (`lib/sandbox.ts:1148`)

Currently collapses each `docker ps -a` line into a per-project `{running, total}`
tally, discarding the per-container `service`/`state` fields it already parsed.
Extend the tally shape to also retain them:

```ts
interface ComposeProjectTally {
  running: number;
  total: number;
  services: { name: string; state: string }[]; // raw docker .State per container
}
```

Same loop, same single `docker ps -a` call — just push `{ name: service, state:
state.trim() }` onto `services` alongside the existing counter increments. No new
docker call.

### Extend `InfraStatus` / `getWorkspaceStatuses()` (`lib/sandbox.ts:1181`)

Add a `services` field, mapped from the infra project's tally to a two-state
up/down list (matches the "running/stopped per container" scope decision):

```ts
interface InfraStatus {
  state: "up" | "partial" | "down" | "unknown";
  running: number;
  total: number;
  services: { name: string; state: "up" | "down" }[]; // new
}
```

`services: (c?.services ?? []).map(s => ({ name: s.name, state: s.state === "running" ? "up" : "down" }))`.
Empty array when `projects === null` (docker unavailable), same as today's
`running`/`total` fallback.

### `workspace-status` tool (`server.ts:769`)

Extend the `outputSchema`'s `infra` object with
`services: z.array(z.object({ name: z.string(), state: z.enum(["up", "down"]) }))`.
No new tool — the Health tab reuses `workspace-status`, same as the top bar does.

### `gke-forwards-status`, `kube-context`, `kube-switch`

Used as-is, unchanged. They already return per-forward detail
(`{name, port, healthy, detail}[]`) and full context/env info — the top bar's
tooltip already renders the unhealthy subset of the same array; the Health tab just
renders all of it as rows instead of a tooltip.

## UI (`src/health-ui.ts`, new)

Dependency-free vanilla DOM, same `el()` helper and CSS-injection approach as
`prs-ui.ts`/`workspace-ui.ts`. Exposes `initHealthUI(bridge, root)` and a `reload()`
for the tab shell (mirrors `initPrsUI`'s return shape). Reuses the `.dot`
ok/warn/bad/unknown classes and `.kube-env` pill classes already defined in
`workspace-ui.ts`'s injected CSS (`.wsui .dot.ok/.warn/.bad/.unknown`,
`.kube-env.dev/.stage/.prod/.other`) by scoping this module's root under the same
`.wsui` class, rather than redefining the palette.

### Layout

Three labeled sections, each a simple row list (name + dot + short state text):

1. **Infra Services** — one row per `infra.services[]` entry from `workspace-status`
   (redis, caddy, gke-forwards, jaeger, cloud-sql-proxy, cloudflare-worker,
   vendor-worker, redisinsight): dot (ok=up, bad=down) + name + state text.
2. **GKE Forwards** — one row per `gke-forwards-status` `forwards[]` entry: dot
   (ok=healthy, bad=unhealthy) + name + port + detail (shown when present, e.g. the
   TCP-connect failure reason).
3. **Kube Context** — env pill (dev/stage/prod/other, same `.kube-env` classes as
   the top bar) + full context string + "Switch to dev" button, shown only when
   env ≠ dev.

A single "↻ Refresh" button at the top re-fetches all three (`workspace-status`,
`gke-forwards-status`, `kube-context` in parallel via `Promise.all`). No polling.

### Tab wiring in `browser-main.ts`

- Add `<button class="wsd-tab" data-tab="health">Health</button>` and
  `<div class="wsd-pane wsd-container" data-pane="health" hidden></div>`.
- Extend the `"list" | "new" | "prs"` tab union to include `"health"` across
  `tabFromHash`, `navigate`, the click handler, and `show()` — same pattern as the
  `prs` tab was added (mirrors `902bf6b4b`).
- Lazy-mount on first show (`healthMounted` flag, like `prsMounted`).
- Document title: `"Health · Sandbox Workspaces"` when active.

## Data flow

```
health-ui.initHealthUI
  └─ Promise.all([
       bridge.callTool("workspace-status")     → infra.services[]
       bridge.callTool("gke-forwards-status")  → forwards[]
       bridge.callTool("kube-context")         → env, context
     ])
  render → three sections

"Switch to dev" → bridge.callTool("kube-switch", { env: "dev" }) → re-paint kube section
"↻ Refresh"      → re-run the Promise.all above
```

## Error handling

Same pattern as the existing top bar (`workspace-ui.ts`'s `refreshKube`/`refreshGke`
catch blocks): if any of the three calls fails, that section keeps its last-known
data on screen and shows an inline "couldn't refresh — click to retry" note rather
than blanking. `kube-switch` failures surface in a per-section message slot and
re-enable the button (mirrors the top bar's `kubeSwitch` handler).

## Testing

Matches this repo's existing convention — a `.smoke.mjs` companion for the one
piece of logic with a real branch: the `dockerComposeProjects` → `InfraStatus`
running/exited-to-up/down mapping (feed synthetic `docker ps` output covering
`running`, `exited`, and a one-shot `-setup` service to confirm it's still
excluded). The `health-ui.ts` rendering itself is integration-tested by hand
(start `sandbox mcp`, open the dashboard, click the Health tab) — same as the top
bar's existing chips, which have no unit coverage either.

## Files touched

| File | Change |
|------|--------|
| `apps/mcp-workspace/lib/sandbox.ts` | extend `dockerComposeProjects` tally with per-container `services`; extend `InfraStatus`/`getWorkspaceStatuses` with `services` |
| `apps/mcp-workspace/server.ts` | extend `workspace-status`'s `outputSchema` with `infra.services` |
| `apps/mcp-workspace/src/health-ui.ts` | **new** — the tab UI |
| `apps/mcp-workspace/src/browser-main.ts` | fourth tab + `#health` route + lazy mount |

## Open questions

None outstanding. Health depth (running/stopped only) and refresh mode (manual
only) confirmed.
