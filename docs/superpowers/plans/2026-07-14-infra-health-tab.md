# Infra Health Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth "Health" tab to the `apps/mcp-workspace` browser dashboard showing per-container shared-infra status, per-forward GKE health, and kube context with a switch-back-to-dev control.

**Architecture:** Extend the existing `workspace-status` MCP tool to surface per-container infra state (data it already reads but discards); reuse `gke-forwards-status`/`kube-context`/`kube-switch` unchanged; add a new dependency-free vanilla-DOM tab module (`health-ui.ts`) mounted as a fourth hash-routed tab in `browser-main.ts`, following the exact pattern the "Open Pull Requests" tab established.

**Tech Stack:** TypeScript (`tsc -p tsconfig.server.json` for `lib/`+`server.ts`, Vite for `src/`), Zod for MCP tool schemas, no test framework — `node:assert`-based `.smoke.mjs` scripts run against the built `dist/` output.

## Global Constraints

- No new dependencies.
- No Docker healthcheck (`.Status`) parsing — running-vs-stopped only, from the existing `.State` field.
- No auto-refresh/polling — manual "↻ Refresh" only.
- Only a "Switch to dev" control — no explicit stage/prod switch buttons.
- The existing top-bar chips in `workspace-ui.ts` are unchanged.
- Follow the existing `.wsui`-style scoped-CSS/vanilla-DOM/`el()`-helper convention already used by `prs-ui.ts` — no new UI library.

---

### Task 1: Extract `parseComposeStatus` and add per-service data to `InfraStatus`

**Files:**
- Modify: `apps/mcp-workspace/lib/sandbox.ts:1122-1223` (the `InfraStatus` interface, `dockerComposeProjects`, and `getWorkspaceStatuses`)
- Create: `apps/mcp-workspace/lib/sandbox.smoke.mjs`

**Interfaces:**
- Produces: `export interface ComposeProjectTally { running: number; total: number; services: { name: string; state: string }[] }`
- Produces: `export function parseComposeStatus(stdout: string): Map<string, ComposeProjectTally>`
- Produces: `InfraStatus.services: { name: string; state: "up" | "down" }[]` (new field on the existing exported interface)
- Consumes: none (this is the first task)

Today, `dockerComposeProjects()` (`lib/sandbox.ts:1148-1173`) runs one `docker ps -a` call and immediately collapses each container's `service`/`state` into a per-project `{running, total}` tally, discarding the per-container detail. This task pulls the parsing loop out into a standalone, unit-testable pure function, and carries the per-container detail through into `InfraStatus` so the Health tab has something to render.

- [ ] **Step 1: Write the failing smoke test**

Create `apps/mcp-workspace/lib/sandbox.smoke.mjs`:

```js
// Smoke test for parseComposeStatus: groups docker-ps lines by Compose project,
// tallies running/total, retains per-container name+state, and excludes one-shot
// `-setup` services from the tally (they're expected to exit).
//   npm run build:server && node lib/sandbox.smoke.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseComposeStatus } = await import(path.join(pkgRoot, "dist/lib/sandbox.js"));

// Mixed running/exited containers across two projects, plus a one-shot setup
// container that should be excluded entirely.
const psOutput = [
  "sandbox-infra\tredis\trunning",
  "sandbox-infra\tcaddy\trunning",
  "sandbox-infra\tgke-forwards\texited",
  "sandbox-my-feature\tweb-v2\trunning",
  "sandbox-my-feature\tproduct-api\texited",
  "sandbox-my-feature\tecon-setup\texited",
].join("\n");

const result = parseComposeStatus(psOutput);

const infra = result.get("sandbox-infra");
assert.equal(infra.running, 2, "2 of 3 sandbox-infra containers running");
assert.equal(infra.total, 3, "3 sandbox-infra containers total");
assert.deepEqual(
  infra.services,
  [
    { name: "redis", state: "running" },
    { name: "caddy", state: "running" },
    { name: "gke-forwards", state: "exited" },
  ],
  "per-container name+state retained in project order",
);

const feature = result.get("sandbox-my-feature");
assert.equal(feature.running, 1, "1 of 2 non-setup sandbox-my-feature containers running");
assert.equal(feature.total, 2, "econ-setup excluded from the tally");
assert.equal(
  feature.services.find((s) => s.name === "econ-setup"),
  undefined,
  "one-shot -setup service excluded from services list too",
);

// Blank lines and rows with no compose-project label are ignored, not counted.
const withNoise = parseComposeStatus("\n\t\tno-project-label\n" + psOutput);
assert.equal(withNoise.get("sandbox-infra").total, 3, "noise lines don't affect real tallies");

console.log("✓ parseComposeStatus: grouping, running/total tally, per-container detail, -setup exclusion, noise lines");
process.exit(0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/mcp-workspace && node lib/sandbox.smoke.mjs`
Expected: FAIL — `dist/lib/sandbox.js` doesn't export `parseComposeStatus` (or the file/build is stale).

- [ ] **Step 3: Extract the pure function and wire it into `dockerComposeProjects`**

In `apps/mcp-workspace/lib/sandbox.ts`, replace the body of `dockerComposeProjects` (currently lines 1148-1173) with:

```ts
export interface ComposeProjectTally {
  running: number;
  total: number;
  services: { name: string; state: string }[];
}

/**
 * Pure parse of `docker ps -a --format '{{.Label ...project}}\t{{.Label ...service}}\t{{.State}}'`
 * output into a per-project tally, excluding one-shot setup containers. Split out
 * from {@link dockerComposeProjects} so it's unit-testable without shelling out.
 */
export function parseComposeStatus(stdout: string): Map<string, ComposeProjectTally> {
  const out = new Map<string, ComposeProjectTally>();
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3 || !parts[0]) continue; // no project label → not a compose container
    const [project, service, state] = parts;
    if (isOneShotService(service)) continue; // setup jobs are meant to exit
    const trimmed = state.trim();
    const e = out.get(project) ?? { running: 0, total: 0, services: [] };
    e.total++;
    if (trimmed === "running") e.running++;
    e.services.push({ name: service, state: trimmed });
    out.set(project, e);
  }
  return out;
}

/**
 * One `docker ps -a` sweep, grouped by Compose project → {running, total, services},
 * excluding one-shot setup containers. Returns null when docker is unavailable
 * (not installed / daemon down), so callers can report "unknown" rather than a
 * misleading "down".
 */
async function dockerComposeProjects(): Promise<Map<string, ComposeProjectTally> | null> {
  let res: { stdout: string; stderr: string; code: number | null };
  try {
    res = await runCapture("docker", [
      "ps",
      "-a",
      "--format",
      '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}',
    ]);
  } catch {
    return null; // docker missing / not on PATH
  }
  if (res.code !== 0) return null; // daemon down
  return parseComposeStatus(res.stdout);
}
```

- [ ] **Step 4: Build and run the smoke test to verify it passes**

Run: `cd apps/mcp-workspace && npm run build:server && node lib/sandbox.smoke.mjs`
Expected: PASS — prints the `✓ parseComposeStatus: ...` line and exits 0.

- [ ] **Step 5: Add `services` to `InfraStatus` and populate it in `getWorkspaceStatuses`**

In `apps/mcp-workspace/lib/sandbox.ts`, update the `InfraStatus` interface (currently `lib/sandbox.ts:1122-1126`):

```ts
/** Shared-infrastructure (`sandbox connect`) container state — the `sandbox-infra` Compose project. */
export interface InfraStatus {
  state: "up" | "partial" | "down" | "unknown";
  running: number;
  total: number;
  /** Per-container running/stopped, for the Health tab's itemized view. */
  services: { name: string; state: "up" | "down" }[];
}
```

Then update the infra-tally block inside `getWorkspaceStatuses` (currently `lib/sandbox.ts:1210-1220`):

```ts
  // Shared infra is a single Compose project — read its tally from the same sweep.
  let infra: InfraStatus;
  if (projects === null) {
    infra = { state: "unknown", running: 0, total: 0, services: [] };
  } else {
    const c = projects.get(INFRA_PROJECT);
    const running = c?.running ?? 0;
    const total = c?.total ?? 0;
    const state = total === 0 ? "down" : running === total ? "up" : running > 0 ? "partial" : "down";
    const services = (c?.services ?? []).map((s) => ({
      name: s.name,
      state: (s.state === "running" ? "up" : "down") as "up" | "down",
    }));
    infra = { state, running, total, services };
  }
```

- [ ] **Step 6: Rebuild and re-run the smoke test**

Run: `cd apps/mcp-workspace && npm run build:server && node lib/sandbox.smoke.mjs`
Expected: PASS (unchanged output — this step only confirms the `InfraStatus` edit didn't break the build).

- [ ] **Step 7: Commit**

```bash
cd apps/mcp-workspace
git add lib/sandbox.ts lib/sandbox.smoke.mjs
git commit -m "$(cat <<'EOF'
feat(mcp-workspace): surface per-container infra state

Extract parseComposeStatus as a pure, unit-tested function and carry
per-container name+state through into InfraStatus, so the Health tab
has itemized data instead of only an aggregate running/total count.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extend the `workspace-status` tool's output schema

**Files:**
- Modify: `apps/mcp-workspace/server.ts:776-781`

**Interfaces:**
- Consumes: `InfraStatus` (from Task 1, now including `services`)
- Produces: `workspace-status` tool's `structuredContent.infra.services` — consumed by `health-ui.ts` in Task 3.

The tool handler already returns the full `InfraStatus` object as-is (`server.ts:814`: `structuredContent: { statuses, infra }`), so the only change needed is the Zod `outputSchema` — without this, `services` would be silently stripped by schema validation before reaching the client.

- [ ] **Step 1: Update the schema**

In `apps/mcp-workspace/server.ts`, change the `infra` object inside the `workspace-status` tool's `outputSchema` (currently lines 777-781):

```ts
      outputSchema: z.object({
        infra: z.object({
          state: z.enum(["up", "partial", "down", "unknown"]),
          running: z.number(),
          total: z.number(),
          services: z.array(z.object({ name: z.string(), state: z.enum(["up", "down"]) })),
        }),
        statuses: z.array(
          z.object({
            name: z.string(),
            project: z.string().nullable(),
            state: z.enum(["up", "partial", "stopped", "down", "unknown"]),
            running: z.number(),
            total: z.number(),
            claude: z.object({
              state: z.enum(["running", "done", "failed", "idle"]),
              waiting: z.boolean(),
            }),
          }),
        ),
      }),
```

- [ ] **Step 2: Build and verify no type errors**

Run: `cd apps/mcp-workspace && npm run build:server`
Expected: exits 0, no TypeScript errors. (No smoke test for this step — it's a schema-only change with no new branching logic; Task 1's smoke test already covers the data it validates. End-to-end verification that the new field actually reaches a client happens in Task 5.)

- [ ] **Step 3: Commit**

```bash
cd apps/mcp-workspace
git add server.ts
git commit -m "$(cat <<'EOF'
feat(mcp-workspace): expose infra.services on workspace-status tool

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Build the Health tab UI module

**Files:**
- Create: `apps/mcp-workspace/src/health-ui.ts`

**Interfaces:**
- Consumes: `HostBridge` from `./workspace-ui.js` (`callTool(name, args?) => Promise<any>`, already defined at `src/workspace-ui.ts:30-40`); the `workspace-status`, `gke-forwards-status`, `kube-context`, `kube-switch` tool responses (shapes from Task 1/2 and the existing `gke-forwards-status`/`kube-context`/`kube-switch` tools already in `server.ts`).
- Produces: `export function initHealthUI(bridge: HostBridge, root: HTMLElement): { reload: () => void }` — consumed by `browser-main.ts` in Task 4 (same return shape as `initPrsUI`).

No automated test for this file — matches this repo's existing convention that UI-rendering modules (`workspace-ui.ts`, `prs-ui.ts`, `create-form.ts`) have no unit coverage; they're verified by hand. Task 5 covers that manual verification.

- [ ] **Step 1: Create the file**

Create `apps/mcp-workspace/src/health-ui.ts`:

```ts
/**
 * "Health" dashboard tab. Dependency-free vanilla DOM (same `el()` +
 * CSS-injection approach as prs-ui.ts / workspace-ui.ts). Three sections —
 * shared infra containers, GKE port-forwards, and kube context — each a
 * simple row list. This is the itemized detail view behind the top bar's
 * aggregate infra/GKE/kube chips in workspace-ui.ts; it doesn't replace them.
 */
import type { HostBridge } from "./workspace-ui.js";

interface InfraService {
  name: string;
  state: "up" | "down";
}
interface WorkspaceStatusResult {
  infra: {
    state: "up" | "partial" | "down" | "unknown";
    running: number;
    total: number;
    services: InfraService[];
  };
}
interface GkeForward {
  name: string;
  port: number;
  healthy: boolean;
  detail: string | null;
}
interface GkeForwardsResult {
  forwards: GkeForward[];
  healthy: number;
  total: number;
}
interface KubeContextResult {
  context: string | null;
  env: "dev" | "stage" | "prod" | "other";
}

const CSS = `
  .health, .health * { box-sizing: border-box; }
  .health {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a1a1a; padding: 16px 20px 40px;
  }
  .health .controls { display: flex; align-items: center; gap: 10px; margin: 4px 0 4px; }
  .health .refresh {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    padding: 7px 12px; border: 1px solid #d9d9d4; border-radius: 8px; background: #fff; color: #1a1a1a;
  }
  .health .refresh:hover { background: #f2f2ef; }
  .health .refresh[disabled] { opacity: .55; cursor: default; }
  .health .load-status { color: #6b6b66; font-size: 13px; padding: 8px 0; min-height: 1em; }
  .health .load-status.err { color: #c0392b; }
  .health .sec-h {
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    color: #6b6b66; margin: 20px 0 8px;
  }
  .health .row {
    display: flex; align-items: center; gap: 8px; padding: 7px 12px;
    border: 1px solid #e5e5e0; border-radius: 8px; background: #fff; margin-bottom: 6px; font-size: 13px;
  }
  .health .dot { width: 8px; height: 8px; border-radius: 50%; background: #b0b0aa; flex: none; }
  .health .dot.ok { background: #29a35a; }
  .health .dot.bad { background: #c0392b; }
  .health .row .name { font-weight: 600; }
  .health .row .state { color: #6b6b66; }
  .health .row .port {
    color: #b0b0a8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  }
  .health .row .detail { color: #c0392b; font-size: 12px; margin-left: auto; }
  .health .kube-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: 1px solid #e5e5e0; border-radius: 8px; background: #fff;
  }
  .health .kube-env {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 2px 7px; border-radius: 999px;
  }
  .health .kube-env.dev { background: #e9f7ef; color: #1e7a46; }
  .health .kube-env.stage { background: #fff4e5; color: #b76a00; }
  .health .kube-env.prod { background: #fde8e8; color: #c0392b; }
  .health .kube-env.other { background: #f0f0ec; color: #6b6b66; }
  .health .kube-ctx { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #6b6b66; }
  .health .btn {
    font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    padding: 6px 12px; border-radius: 7px; border: 1px solid #d9d9d4; background: #fff; color: #1a1a1a;
    margin-left: auto;
  }
  .health .btn:hover { background: #f2f2ef; }
  .health .btn[disabled] { opacity: .55; cursor: default; }
`;

export function initHealthUI(bridge: HostBridge, root: HTMLElement): { reload: () => void } {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  root.classList.add("health");
  root.innerHTML = `
    <div class="controls">
      <button class="refresh" data-id="refresh">↻ Refresh</button>
    </div>
    <div class="load-status" data-id="status"></div>
    <div class="sec-h">Infra Services</div>
    <div data-id="infra"></div>
    <div class="sec-h">GKE Forwards</div>
    <div data-id="gke"></div>
    <div class="sec-h">Kube Context</div>
    <div data-id="kube"></div>`;

  const $ = (id: string) => root.querySelector(`[data-id="${id}"]`) as HTMLElement;
  const call = (tool: string, args?: Record<string, unknown>) => bridge.callTool(tool, args);

  function el(tag: string, cls?: string | null, txt?: string | null): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  let lastInfra: InfraService[] | null = null;
  let lastGke: GkeForward[] | null = null;
  let lastKube: KubeContextResult | null = null;

  function renderInfra(services: InfraService[]): void {
    const host = $("infra");
    host.innerHTML = "";
    if (!services.length) {
      host.appendChild(el("div", "row", "No infra containers found (is `sandbox connect` running?)"));
      return;
    }
    for (const s of services) {
      const row = el("div", "row");
      row.appendChild(el("span", `dot ${s.state === "up" ? "ok" : "bad"}`));
      row.appendChild(el("span", "name", s.name));
      row.appendChild(el("span", "state", s.state));
      host.appendChild(row);
    }
  }

  function renderGke(forwards: GkeForward[]): void {
    const host = $("gke");
    host.innerHTML = "";
    if (!forwards.length) {
      host.appendChild(el("div", "row", "No GKE forwards configured"));
      return;
    }
    for (const f of forwards) {
      const row = el("div", "row");
      row.appendChild(el("span", `dot ${f.healthy ? "ok" : "bad"}`));
      row.appendChild(el("span", "name", f.name));
      row.appendChild(el("span", "port", `:${f.port}`));
      if (!f.healthy && f.detail) row.appendChild(el("span", "detail", f.detail));
      host.appendChild(row);
    }
  }

  function renderKube(env: KubeContextResult["env"], context: string | null): void {
    const host = $("kube");
    host.innerHTML = "";
    const row = el("div", "kube-row");
    const known: "dev" | "stage" | "prod" | "other" =
      env === "dev" || env === "stage" || env === "prod" ? env : "other";
    row.appendChild(el("span", `kube-env ${known}`, known === "other" ? "unknown" : env));
    row.appendChild(el("span", "kube-ctx", context || "(no context)"));
    if (env !== "dev") {
      const btn = el("button", "btn", "Switch to dev") as HTMLButtonElement;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Switching…";
        try {
          const k = (await call("kube-switch", { env: "dev" })) as KubeContextResult;
          lastKube = k;
          renderKube(k.env ?? "dev", k.context ?? null);
        } catch {
          btn.disabled = false;
          btn.textContent = "Switch to dev";
          row.appendChild(el("span", "detail", "Switch failed — try again"));
        }
      });
      row.appendChild(btn);
    }
    host.appendChild(row);
  }

  async function load(): Promise<void> {
    const status = $("status");
    const refresh = $("refresh") as HTMLButtonElement;
    refresh.disabled = true;
    const [ws, gke, kube] = await Promise.allSettled([
      call("workspace-status", {}) as Promise<WorkspaceStatusResult>,
      call("gke-forwards-status", {}) as Promise<GkeForwardsResult>,
      call("kube-context", {}) as Promise<KubeContextResult>,
    ]);
    const failed: string[] = [];
    if (ws.status === "fulfilled") {
      lastInfra = ws.value.infra.services;
      renderInfra(lastInfra);
    } else failed.push("infra services");
    if (gke.status === "fulfilled") {
      lastGke = gke.value.forwards;
      renderGke(lastGke);
    } else failed.push("GKE forwards");
    if (kube.status === "fulfilled") {
      lastKube = kube.value;
      renderKube(lastKube.env, lastKube.context);
    } else failed.push("kube context");

    status.className = failed.length ? "load-status err" : "load-status";
    status.textContent = failed.length
      ? `Couldn't refresh ${failed.join(", ")} — showing last known data. Click Refresh to retry.`
      : "";
    refresh.disabled = false;
  }

  $("refresh").addEventListener("click", () => void load());
  void load();

  return { reload: () => void load() };
}
```

- [ ] **Step 2: Type-check the new file**

Run: `cd apps/mcp-workspace && npx tsc --noEmit -p tsconfig.server.json 2>&1 | grep health-ui || echo "no errors in health-ui.ts"`
Expected: `no errors in health-ui.ts` (this file isn't in `tsconfig.server.json`'s `include`, so this command just confirms it doesn't break that build; the real type-check for `src/` files happens via Vite in Task 4/5 once it's imported).

- [ ] **Step 3: Commit**

```bash
cd apps/mcp-workspace
git add src/health-ui.ts
git commit -m "$(cat <<'EOF'
feat(mcp-workspace): add Health tab UI module

initHealthUI renders three sections — infra services, GKE forwards,
kube context — from the workspace-status/gke-forwards-status/
kube-context tools, with manual refresh and a switch-to-dev control.
Not yet wired into the dashboard shell (next commit).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire the Health tab into `browser-main.ts`

**Files:**
- Modify: `apps/mcp-workspace/src/browser-main.ts` (whole file — the tab union type touches most of it)

**Interfaces:**
- Consumes: `initHealthUI` from `./health-ui.js` (Task 3)
- Produces: `#health` route, fourth tab button — nothing downstream depends on this.

This mirrors exactly how the `prs` tab was added (commit `902bf6b4b`): extend the tab union, add a button + pane, lazy-mount on first show.

- [ ] **Step 1: Add the import and tab button/pane**

In `apps/mcp-workspace/src/browser-main.ts`, add the import near the top (after the `initPrsUI` import, currently line 16):

```ts
import { initHealthUI } from "./health-ui.js";
```

Add a fourth tab button and pane to the shell HTML (currently lines 80-92):

```ts
root.innerHTML = `
  <div class="wsd-header wsd-container" data-id="shell-header"></div>
  <div class="wsd-tabs">
    <div class="wsd-tabrow wsd-container">
      <button class="wsd-tab active" data-tab="list">Workspaces</button>
      <button class="wsd-tab" data-tab="new">New workspace</button>
      <button class="wsd-tab" data-tab="prs">Open Pull Requests</button>
      <button class="wsd-tab" data-tab="health">Health</button>
    </div>
  </div>
  <div class="wsd-pane wsd-container" data-pane="list"></div>
  <div class="wsd-pane wsd-container" data-pane="new" hidden></div>
  <div class="wsd-pane wsd-container" data-pane="prs" hidden></div>
  <div class="wsd-pane wsd-container" data-pane="health" hidden></div>
`;
```

Add the pane reference next to the others (currently lines 94-98):

```ts
const shellHeader = root.querySelector('[data-id="shell-header"]') as HTMLElement;
const listPane = root.querySelector('[data-pane="list"]') as HTMLElement;
const newPane = root.querySelector('[data-pane="new"]') as HTMLElement;
const prsPane = root.querySelector('[data-pane="prs"]') as HTMLElement;
const healthPane = root.querySelector('[data-pane="health"]') as HTMLElement;
const tabs = [...root.querySelectorAll<HTMLButtonElement>(".wsd-tab")];
```

- [ ] **Step 2: Extend the tab union everywhere it appears**

Replace the mount-state declarations (currently lines 103-105):

```ts
let createMounted = false;
let prsMounted = false;
let prs: { reload: () => void } | null = null;
let healthMounted = false;
```

Replace `show()` (currently lines 112-136):

```ts
function show(tab: "list" | "new" | "prs" | "health"): void {
  tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  listPane.hidden = tab !== "list";
  newPane.hidden = tab !== "new";
  prsPane.hidden = tab !== "prs";
  healthPane.hidden = tab !== "health";
  document.title =
    tab === "new"
      ? "New workspace · Sandbox Workspaces"
      : tab === "prs"
        ? "Open Pull Requests · Sandbox Workspaces"
        : tab === "health"
          ? "Health · Sandbox Workspaces"
          : "Sandbox Workspaces";
  if (tab === "new" && !createMounted) {
    createMounted = true;
    initCreateForm(bridge, newPane, {
      onCreated: () => {
        list.reload();
        navigate("list");
      },
    });
  }
  if (tab === "prs" && !prsMounted) {
    prsMounted = true;
    prs = initPrsUI(bridge, prsPane);
  }
  if (tab === "health" && !healthMounted) {
    healthMounted = true;
    initHealthUI(bridge, healthPane);
  }
}
```

Replace `tabFromHash` and `navigate` (currently lines 138-148):

```ts
function tabFromHash(): "list" | "new" | "prs" | "health" {
  const h = location.hash.replace(/^#/, "");
  return h === "new" ? "new" : h === "prs" ? "prs" : h === "health" ? "health" : "list";
}

function navigate(tab: "list" | "new" | "prs" | "health"): void {
  // Setting the hash adds a history entry and fires hashchange (which renders).
  // If we're already on that hash there's no event, so render directly.
  if (tabFromHash() === tab) show(tab);
  else location.hash = tab;
}
```

Update the click-handler cast (currently line 150):

```ts
tabs.forEach((b) => b.addEventListener("click", () => navigate(b.dataset.tab as "list" | "new" | "prs" | "health")));
```

- [ ] **Step 3: Build the UI bundle**

Run: `cd apps/mcp-workspace && npm run build:ui`
Expected: exits 0. If Vite reports a TypeScript error, fix it before continuing — this is the first point the new file is actually type-checked (this repo's `src/` modules are type-checked by Vite's `vite build`, not `tsc`, since they're not in `tsconfig.server.json`'s `include`).

- [ ] **Step 4: Commit**

```bash
cd apps/mcp-workspace
git add src/browser-main.ts
git commit -m "$(cat <<'EOF'
feat(mcp-workspace): wire Health tab into dashboard shell

Fourth tab + #health route, mirroring how the Open Pull Requests tab
was added — extends the tab union across show()/tabFromHash()/
navigate()/the click handler, lazy-mounts initHealthUI on first show.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: End-to-end verification

**Files:** none (manual verification only)

**Interfaces:** none — this task consumes the fully wired feature from Tasks 1-4 and produces nothing further.

- [ ] **Step 1: Full build**

Run: `cd apps/mcp-workspace && npm run build:server && npm run build:ui`
Expected: both exit 0.

- [ ] **Step 2: Start the dashboard**

Run: `./sandbox mcp` from the repo root (or however you normally start it per this repo's README), then open the browser dashboard (`http://localhost:3001` per `lib/browser-ui.ts`).

- [ ] **Step 3: Exercise the tab**

- Click the **Health** tab. Confirm the URL hash becomes `#health` and the document title becomes "Health · Sandbox Workspaces".
- Confirm the **Infra Services** section lists rows for `redis`, `caddy`, `gke-forwards`, `jaeger`, `cloud-sql-proxy`, `cloudflare-worker`, `vendor-worker`, `redisinsight` (whichever are currently defined in `infra/compose/shared-infra.yml`), each with a green (`up`) or red (`down`) dot matching `docker ps` reality — cross-check with `docker ps --filter label=com.docker.compose.project=sandbox-infra`.
- Confirm the **GKE Forwards** section lists one row per forward in `infra/config/gke-forwards.yaml`, with health matching what the existing top-bar chip's tooltip already shows.
- Confirm the **Kube Context** section shows your current env/context. If your kubectl context is already `dev`, temporarily switch away (`kubectl config use-context <stage-or-prod-context>`) to confirm the "Switch to dev" button appears and successfully switches back on click (re-check with `kubectl config current-context`).
- Click **↻ Refresh** and confirm all three sections re-fetch (network tab or a visible flicker/update is enough).
- Reload the page with `#health` in the URL directly and confirm it deep-links straight to the Health tab.

- [ ] **Step 4: Confirm the existing top bar and other tabs are unaffected**

Click through **Workspaces**, **New workspace**, and **Open Pull Requests** and confirm they behave exactly as before — this task only adds a tab, it shouldn't change anything else.

- [ ] **Step 5: Run the full smoke suite to confirm nothing else broke**

Run: `cd apps/mcp-workspace && for f in lib/*.smoke.mjs; do node "$f" || exit 1; done`
Expected: every smoke test prints its `✓`/`PASS` line and the loop exits 0.

No commit for this task — it's verification only, nothing to check in.
