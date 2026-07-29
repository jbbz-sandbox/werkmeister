# Per-workspace Token & Model Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand, per-workspace breakdown of Claude Code token usage by model, with a configurable dollar estimate, surfaced in both dashboard tabs.

**Architecture:** A reducer in `lib/sandbox.ts` sums `message.usage` from a workspace's Claude Code session JSONL files (found via the existing `resolveWorkspaceDir → findClaudeProjectDir → listSessionFiles` chain), keyed by `message.model`. Rates come from a configurable `infra/config/model-pricing.yaml` (with an in-code fallback). A `workspace-usage` MCP tool exposes it; a shared `renderUsage()` widget renders it under a "Usage" button in both the Workspaces and Health tabs.

**Tech Stack:** TypeScript (Node ESM), the `yaml` dep already in `apps/mcp-workspace`, vanilla-DOM UI (no framework), `node:assert` smoke tests.

## Global Constraints

- Node ESM: relative imports end in `.js`; smoke tests import from `dist/lib/*.js` after a build.
- No new dependencies. `yaml`, `node:fs`, `node:path`, `node:os`, `readline` are already imported in `lib/sandbox.ts`.
- UI files (`src/*.ts`) run in the browser and CANNOT import from `lib/sandbox.ts`; they declare their own local interfaces mirroring the server's `structuredContent` shape (see `health-ui.ts`'s local `FeatureStatus`).
- Sum the **top-level** `message.usage` fields only — never `usage.iterations[]` (double-counts a tool-loop turn).
- Unknown model (absent from price table) → tokens shown, `estUsd: null`. Never guess a rate.
- Only sessions in the workspace-root project dir are counted (consistent with existing session tooling). Do not add multi-repo subdir scanning.
- Build/verify from `apps/mcp-workspace/`: `npm run build:server` (tsc) for smoke tests; `npm run build` for the full UI typecheck.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `infra/config/model-pricing.yaml` | **new** — configurable per-MTok USD rates |
| `apps/mcp-workspace/lib/sandbox.ts` | **modify** — usage types, `reduceUsageLines`, `estimateUsd`, price loader, `getWorkspaceUsage` |
| `apps/mcp-workspace/lib/usage.smoke.mjs` | **new** — smoke test for the reducer + cost math |
| `apps/mcp-workspace/server.ts` | **modify** — register `workspace-usage` tool |
| `apps/mcp-workspace/src/usage-widget.ts` | **new** — shared `renderUsage()` |
| `apps/mcp-workspace/src/workspace-ui.ts` | **modify** — Usage button + panel per card |
| `apps/mcp-workspace/src/health-ui.ts` | **modify** — Usage button + panel per feature row |

---

## Task 1: Usage reducer, pricing, and `getWorkspaceUsage`

**Files:**
- Create: `infra/config/model-pricing.yaml`
- Modify: `apps/mcp-workspace/lib/sandbox.ts` (add near the existing Claude-transcript section, ~line 2320+)
- Test: `apps/mcp-workspace/lib/usage.smoke.mjs`

**Interfaces:**
- Consumes (existing, private in same module): `resolveWorkspaceDir(name)`, `findClaudeProjectDir(path)`, `listSessionFiles(dir)`, `readSessionTitle(file, id)`, `encodeClaudeProjectDir`.
- Produces (exported):
  - `interface UsageTotals { input: number; output: number; cacheCreation: number; cacheRead: number }`
  - `interface ModelRate { input: number; output: number; cacheWrite: number; cacheRead: number }`
  - `interface ModelUsage { model: string; totals: UsageTotals; estUsd: number | null }`
  - `interface SessionUsage { sessionId: string; title: string; updatedAt: string; totals: UsageTotals; estUsd: number | null }`
  - `interface WorkspaceUsage { name: string; totals: UsageTotals; estUsd: number | null; byModel: ModelUsage[]; sessions: SessionUsage[] }`
  - `function reduceUsageLines(text: string): Map<string, UsageTotals>`
  - `function estimateUsd(t: UsageTotals, rate: ModelRate | undefined): number | null`
  - `async function getWorkspaceUsage(name: string): Promise<WorkspaceUsage>`

- [ ] **Step 1: Create the pricing config file**

Create `infra/config/model-pricing.yaml`:

```yaml
# Per-million-token USD rates for estimating Claude Code usage cost.
# Add or reprice models here — no code change needed. Unknown models show
# token counts with no dollar estimate. Rates are approximate; update when
# published pricing changes.
models:
  claude-opus-4-8:  { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 }
  claude-sonnet-5:  { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.30 }
  claude-haiku-4-5: { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.10 }
```

- [ ] **Step 2: Write the failing smoke test**

Create `apps/mcp-workspace/lib/usage.smoke.mjs`:

```js
// Smoke test for lib/sandbox usage reducer + cost math.
//   npm run build:server && node lib/usage.smoke.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { reduceUsageLines, estimateUsd } = await import(path.join(pkgRoot, "dist/lib/sandbox.js"));

const line = (model, u) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model, usage: u } }) + "\n";

// Two opus turns + one unknown-model turn, plus a non-assistant line to skip.
const text =
  line("claude-opus-4-8", { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 300, cache_read_input_tokens: 400 }) +
  line("claude-opus-4-8", { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }) +
  '{"type":"user","message":{"role":"user","content":"hi"}}\n' +
  line("mystery-model", { input_tokens: 1, output_tokens: 2 });

const byModel = reduceUsageLines(text);

// Per-model accumulation, top-level fields only.
const opus = byModel.get("claude-opus-4-8");
assert.deepStrictEqual(opus, { input: 110, output: 220, cacheCreation: 330, cacheRead: 440 });
const mystery = byModel.get("mystery-model");
assert.deepStrictEqual(mystery, { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 });

// Cost math: 110/1e6*15 + 220/1e6*75 + 330/1e6*18.75 + 440/1e6*1.5
const rate = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };
const expected = 110e-6 * 15 + 220e-6 * 75 + 330e-6 * 18.75 + 440e-6 * 1.5;
assert.ok(Math.abs(estimateUsd(opus, rate) - expected) < 1e-12, "opus cost");

// Unknown rate → null, never a guess.
assert.strictEqual(estimateUsd(mystery, undefined), null);

console.log("usage.smoke OK");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/mcp-workspace && npm run build:server && node lib/usage.smoke.mjs`
Expected: build fails or the import throws — `reduceUsageLines`/`estimateUsd` are not exported yet.

- [ ] **Step 4: Implement the reducer, cost math, price loader, and `getWorkspaceUsage`**

In `apps/mcp-workspace/lib/sandbox.ts`, add after the transcript helpers (after `parseSessionLines`, around line 2360). Note `parse as parseYaml` is already imported at the top:

```ts
// --- Per-workspace usage: token/model totals over session JSONL ------------

export interface UsageTotals { input: number; output: number; cacheCreation: number; cacheRead: number; }
export interface ModelRate { input: number; output: number; cacheWrite: number; cacheRead: number; }
export interface ModelUsage { model: string; totals: UsageTotals; estUsd: number | null; }
export interface SessionUsage { sessionId: string; title: string; updatedAt: string; totals: UsageTotals; estUsd: number | null; }
export interface WorkspaceUsage { name: string; totals: UsageTotals; estUsd: number | null; byModel: ModelUsage[]; sessions: SessionUsage[]; }

const zeroTotals = (): UsageTotals => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
function addTotals(into: UsageTotals, t: UsageTotals): void {
  into.input += t.input; into.output += t.output;
  into.cacheCreation += t.cacheCreation; into.cacheRead += t.cacheRead;
}

/**
 * Sum one session file's assistant `message.usage` by model. Reads only the
 * TOP-LEVEL usage fields (never `iterations[]`, which itemizes a single
 * tool-loop turn and would double-count). Unparseable lines are skipped.
 */
export function reduceUsageLines(text: string): Map<string, UsageTotals> {
  const byModel = new Map<string, UsageTotals>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; message?: { model?: string; usage?: Record<string, number> } };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "assistant") continue;
    const u = e.message?.usage;
    const model = e.message?.model;
    if (!u || !model) continue;
    let acc = byModel.get(model);
    if (!acc) { acc = zeroTotals(); byModel.set(model, acc); }
    acc.input += u.input_tokens ?? 0;
    acc.output += u.output_tokens ?? 0;
    acc.cacheCreation += u.cache_creation_input_tokens ?? 0;
    acc.cacheRead += u.cache_read_input_tokens ?? 0;
  }
  return byModel;
}

/** Estimate USD for one model's totals, or null when the model has no rate. */
export function estimateUsd(t: UsageTotals, rate: ModelRate | undefined): number | null {
  if (!rate) return null;
  return t.input / 1e6 * rate.input
    + t.output / 1e6 * rate.output
    + t.cacheCreation / 1e6 * rate.cacheWrite
    + t.cacheRead / 1e6 * rate.cacheRead;
}

// Fallback used when infra/config/model-pricing.yaml is missing/unparseable.
const DEFAULT_PRICES: Record<string, ModelRate> = {
  "claude-opus-4-8": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** Locate infra/config/model-pricing.yaml (env override → walk up), mirroring resolveServicesYaml. */
async function resolveModelPricingYaml(): Promise<string | null> {
  const explicit = process.env.SANDBOX_MODEL_PRICING_YAML;
  if (explicit && (await isFile(explicit))) return explicit;
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, "infra", "config", "model-pricing.yaml");
    if (await isFile(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadPriceTable(): Promise<Record<string, ModelRate>> {
  const p = await resolveModelPricingYaml();
  if (!p) return DEFAULT_PRICES;
  try {
    const doc = parseYaml(await fs.readFile(p, "utf-8")) as { models?: Record<string, ModelRate> };
    return doc?.models && Object.keys(doc.models).length ? doc.models : DEFAULT_PRICES;
  } catch {
    return DEFAULT_PRICES;
  }
}

/**
 * Sum a workspace's Claude Code token usage by model and by session, with a
 * configurable USD estimate. On-demand (no cache); reads every session file's
 * lines. Counts only sessions in the workspace-root project dir.
 */
export async function getWorkspaceUsage(name: string): Promise<WorkspaceUsage> {
  const empty: WorkspaceUsage = { name, totals: zeroTotals(), estUsd: null, byModel: [], sessions: [] };
  const target = await resolveWorkspaceDir(name);
  const projectDir = await findClaudeProjectDir(target);
  if (!projectDir) return empty;
  const files = await listSessionFiles(projectDir); // newest first
  const prices = await loadPriceTable();

  const wsByModel = new Map<string, UsageTotals>();
  const sessions: SessionUsage[] = [];

  for (const f of files) {
    let text: string;
    try { text = await fs.readFile(f.file, "utf-8"); } catch { continue; }
    const perModel = reduceUsageLines(text);
    if (!perModel.size) continue;
    const sessionTotals = zeroTotals();
    let sessionUsd: number | null = null;
    for (const [model, t] of perModel) {
      let acc = wsByModel.get(model);
      if (!acc) { acc = zeroTotals(); wsByModel.set(model, acc); }
      addTotals(acc, t);
      addTotals(sessionTotals, t);
      const usd = estimateUsd(t, prices[model]);
      if (usd != null) sessionUsd = (sessionUsd ?? 0) + usd;
    }
    const sessionId = path.basename(f.file, ".jsonl");
    sessions.push({
      sessionId,
      title: await readSessionTitle(f.file, sessionId),
      updatedAt: f.mtime.toISOString(),
      totals: sessionTotals,
      estUsd: sessionUsd,
    });
  }

  const byModel: ModelUsage[] = [...wsByModel].map(([model, totals]) => ({
    model, totals, estUsd: estimateUsd(totals, prices[model]),
  }));
  const totals = zeroTotals();
  let estUsd: number | null = null;
  for (const m of byModel) {
    addTotals(totals, m.totals);
    if (m.estUsd != null) estUsd = (estUsd ?? 0) + m.estUsd;
  }
  byModel.sort((a, b) => (b.estUsd ?? 0) - (a.estUsd ?? 0)
    || (b.totals.input + b.totals.output) - (a.totals.input + a.totals.output));

  return { name, totals, estUsd, byModel, sessions };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/mcp-workspace && npm run build:server && node lib/usage.smoke.mjs`
Expected: `usage.smoke OK`

- [ ] **Step 6: Commit**

```bash
git add infra/config/model-pricing.yaml apps/mcp-workspace/lib/sandbox.ts apps/mcp-workspace/lib/usage.smoke.mjs
git commit -m "feat(mcp-workspace): add per-workspace usage reducer + pricing"
```

---

## Task 2: `workspace-usage` MCP tool

**Files:**
- Modify: `apps/mcp-workspace/server.ts` (add a `registerTool` block next to `workspace-status`, ~line 884; add `getWorkspaceUsage` + the usage types to the `lib/sandbox.js` import at ~line 44)

**Interfaces:**
- Consumes: `getWorkspaceUsage(name)`, `WorkspaceUsage`, `WorkspaceError` (all from `./lib/sandbox.js`).
- Produces: tool `"workspace-usage"`, input `{ name: string }`, `structuredContent` matching `WorkspaceUsage`.

- [ ] **Step 1: Add the import**

In `apps/mcp-workspace/server.ts`, add `getWorkspaceUsage,` to the existing named import from `./lib/sandbox.js` (the block that already imports `getWorkspaceStatuses`, `listWorkspaces`).

- [ ] **Step 2: Register the tool**

Add after the `workspace-status` registration (after line ~884). `z` is already imported:

```ts
  // --- Tool: per-workspace token/model usage --------------------------------
  server.registerTool(
    "workspace-usage",
    {
      title: "Workspace Token Usage",
      description:
        "Sum a workspace's Claude Code token usage by model and session, with a " +
        "rough USD estimate (rates from infra/config/model-pricing.yaml). On-demand.",
      inputSchema: { name: z.string().describe("Workspace name") },
      outputSchema: {
        name: z.string(),
        totals: z.object({
          input: z.number(), output: z.number(),
          cacheCreation: z.number(), cacheRead: z.number(),
        }),
        estUsd: z.number().nullable(),
        byModel: z.array(z.object({
          model: z.string(),
          totals: z.object({
            input: z.number(), output: z.number(),
            cacheCreation: z.number(), cacheRead: z.number(),
          }),
          estUsd: z.number().nullable(),
        })),
        sessions: z.array(z.object({
          sessionId: z.string(), title: z.string(), updatedAt: z.string(),
          totals: z.object({
            input: z.number(), output: z.number(),
            cacheCreation: z.number(), cacheRead: z.number(),
          }),
          estUsd: z.number().nullable(),
        })),
      },
    },
    async ({ name }): Promise<CallToolResult> => {
      try {
        const usage = await getWorkspaceUsage(name);
        const tot = usage.totals.input + usage.totals.output + usage.totals.cacheCreation + usage.totals.cacheRead;
        const dollars = usage.estUsd == null ? "" : ` · ~$${usage.estUsd.toFixed(2)}`;
        const models = usage.byModel.map((m) => m.model).join(", ") || "none";
        const text = `${name}: ${tot.toLocaleString()} tokens${dollars} across ${usage.sessions.length} session(s) [${models}]`;
        return {
          content: [{ type: "text", text }],
          structuredContent: usage as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );
```

- [ ] **Step 3: Verify the server builds and the tool works end-to-end**

Run: `cd apps/mcp-workspace && npm run build:server`
Expected: tsc succeeds (no type errors).

Then extend `lib/usage.smoke.mjs` with an end-to-end check through a fabricated workspace (append before the final `console.log`):

```js
// --- getWorkspaceUsage end-to-end over a fabricated workspace + pricing file ---
import fs from "node:fs";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
const home = path.join(tmp, "home");
const wsRoot = path.join(tmp, "workspaces");
const wsPath = path.join(wsRoot, "demo");
fs.mkdirSync(wsPath, { recursive: true });
process.env.HOME = home;
process.env.SANDBOX_WORKSPACES_ROOT = wsRoot;

const encoded = wsPath.replace(/[^a-zA-Z0-9]/g, "-");
const projDir = path.join(home, ".claude", "projects", encoded);
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, "sess1.jsonl"),
  line("claude-opus-4-8", { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));

const pricingPath = path.join(tmp, "model-pricing.yaml");
fs.writeFileSync(pricingPath, "models:\n  claude-opus-4-8: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 }\n");
process.env.SANDBOX_MODEL_PRICING_YAML = pricingPath;

const { getWorkspaceUsage } = await import(path.join(pkgRoot, "dist/lib/sandbox.js"));
const ws = await getWorkspaceUsage("demo");
assert.strictEqual(ws.byModel.length, 1);
assert.strictEqual(ws.byModel[0].model, "claude-opus-4-8");
assert.deepStrictEqual(ws.totals, { input: 100, output: 200, cacheCreation: 0, cacheRead: 0 });
assert.ok(Math.abs(ws.estUsd - (100e-6 * 15 + 200e-6 * 75)) < 1e-12, "ws estUsd");
assert.strictEqual(ws.sessions.length, 1);
```

Run: `cd apps/mcp-workspace && npm run build:server && node lib/usage.smoke.mjs`
Expected: `usage.smoke OK`

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-workspace/server.ts apps/mcp-workspace/lib/usage.smoke.mjs
git commit -m "feat(mcp-workspace): expose workspace-usage MCP tool"
```

---

## Task 3: Shared `renderUsage` widget

**Files:**
- Create: `apps/mcp-workspace/src/usage-widget.ts`

**Interfaces:**
- Consumes: nothing (browser-side; declares its own `WorkspaceUsage` shape mirroring the server's `structuredContent`).
- Produces: `export function renderUsage(container: HTMLElement, usage: WorkspaceUsage): void` and `export interface WorkspaceUsage` (+ nested `UsageTotals`, `ModelUsage`, `SessionUsage`).

- [ ] **Step 1: Write the widget**

Create `apps/mcp-workspace/src/usage-widget.ts`:

```ts
/**
 * Shared, dependency-free usage breakdown renderer. Mounted by both the
 * Workspaces tab (workspace-ui.ts) and the Health tab (health-ui.ts) under a
 * "Usage" button. Shape mirrors the workspace-usage tool's structuredContent
 * (UI code can't import the server lib, so the type is duplicated here).
 */
export interface UsageTotals { input: number; output: number; cacheCreation: number; cacheRead: number; }
export interface ModelUsage { model: string; totals: UsageTotals; estUsd: number | null; }
export interface SessionUsage { sessionId: string; title: string; updatedAt: string; totals: UsageTotals; estUsd: number | null; }
export interface WorkspaceUsage { name: string; totals: UsageTotals; estUsd: number | null; byModel: ModelUsage[]; sessions: SessionUsage[]; }

function el(tag: string, cls?: string | null, txt?: string | null): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

const sum = (t: UsageTotals): number => t.input + t.output + t.cacheCreation + t.cacheRead;

function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
const fmtUsd = (v: number | null): string => (v == null ? "—" : "~$" + v.toFixed(2));

export function renderUsage(container: HTMLElement, usage: WorkspaceUsage): void {
  container.innerHTML = "";
  container.classList.add("usage");
  if (!usage.sessions.length) {
    container.appendChild(el("div", "usage-empty", "No usage recorded for this workspace yet."));
    return;
  }

  // Grand total.
  const head = el("div", "usage-total");
  head.appendChild(el("span", "usage-usd", fmtUsd(usage.estUsd)));
  head.appendChild(el("span", "usage-tok", fmtTokens(sum(usage.totals)) + " tok"));
  container.appendChild(head);

  // Per-model.
  container.appendChild(el("div", "usage-h", "By model"));
  for (const m of usage.byModel) {
    const row = el("div", "usage-row");
    row.appendChild(el("span", "usage-name", m.model));
    row.appendChild(el("span", "usage-usd", fmtUsd(m.estUsd)));
    row.appendChild(el("span", "usage-tok", fmtTokens(sum(m.totals)) + " tok"));
    row.appendChild(el("span", "usage-split",
      `in ${fmtTokens(m.totals.input)} · out ${fmtTokens(m.totals.output)} · cache-r ${fmtTokens(m.totals.cacheRead)}`));
    container.appendChild(row);
  }

  // Per-session (newest first). Flag the costliest session as "hot".
  const hottest = usage.sessions.reduce((a, b) => ((b.estUsd ?? 0) > (a.estUsd ?? 0) ? b : a), usage.sessions[0]);
  container.appendChild(el("div", "usage-h", `Sessions (${usage.sessions.length})`));
  for (const s of usage.sessions) {
    const row = el("div", "usage-row sub");
    row.appendChild(el("span", "usage-name", s.title || s.sessionId.slice(0, 8)));
    row.appendChild(el("span", "usage-usd", fmtUsd(s.estUsd)));
    row.appendChild(el("span", "usage-tok", fmtTokens(sum(s.totals)) + " tok"));
    if (s === hottest && (s.estUsd ?? 0) > 0) row.appendChild(el("span", "usage-hot", "🔥"));
    container.appendChild(row);
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/mcp-workspace && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (The widget is not yet imported anywhere; that's Task 4.)

- [ ] **Step 3: Commit**

```bash
git add apps/mcp-workspace/src/usage-widget.ts
git commit -m "feat(mcp-workspace): add shared usage breakdown widget"
```

---

## Task 4: Wire the Usage button into both tabs

**Files:**
- Modify: `apps/mcp-workspace/src/workspace-ui.ts` (`buildActions`, ~line 497; `render`, ~line 600)
- Modify: `apps/mcp-workspace/src/health-ui.ts` (`renderFeatures`, ~line 162)

**Interfaces:**
- Consumes: `renderUsage`, `WorkspaceUsage` from `./usage-widget.js`; `bridge.callTool("workspace-usage", { name })`.

- [ ] **Step 1: Import the widget in workspace-ui.ts**

At the top of `apps/mcp-workspace/src/workspace-ui.ts`, add:

```ts
import { renderUsage, type WorkspaceUsage } from "./usage-widget.js";
```

- [ ] **Step 2: Add a Usage button + panel to the workspace card**

In `buildActions` (`workspace-ui.ts`), before `wrap.appendChild(msg);`, add a button that toggles a lazily-loaded panel. The panel div is created here and returned via a closure the card can mount; simplest is to append the panel to the card in `render`. Add this helper call inside `buildActions` right after the `addBtn("Remove", …)` line:

```ts
    // Usage: on-demand token/model breakdown, toggled open below the actions.
    const usagePanel = el("div", "usage-panel");
    usagePanel.style.display = "none";
    const usageBtn = el("button", "btn", "Usage") as HTMLButtonElement;
    usageBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (usagePanel.style.display !== "none") { usagePanel.style.display = "none"; return; }
      usagePanel.style.display = "";
      usagePanel.textContent = "Computing usage…";
      try {
        const u = (await call("workspace-usage", { name: w.name })) as WorkspaceUsage;
        renderUsage(usagePanel, u);
      } catch {
        usagePanel.textContent = "Failed to load usage.";
      }
    });
    // Insert the button before the status message, and stash the panel on the
    // wrap so render() can mount it right after the actions bar.
    wrap.insertBefore(usageBtn, msg);
    (wrap as HTMLElement & { _usagePanel?: HTMLElement })._usagePanel = usagePanel;
```

Then in `render`, where the card is assembled, mount the panel immediately after the actions element. Find where `buildActions(w)` result is appended to the card and change it to also append its panel:

```ts
      const actionsEl = buildActions(w);
      ws.appendChild(actionsEl);
      const usagePanel = (actionsEl as HTMLElement & { _usagePanel?: HTMLElement })._usagePanel;
      if (usagePanel) ws.appendChild(usagePanel);
```

(If `render` currently does `ws.appendChild(buildActions(w))` inline, split it into the two-line form above.)

- [ ] **Step 3: Add minimal panel styling to workspace-ui.ts**

In the `<style>` block of `workspace-ui.ts` (near the `.wsui .actions` rule, ~line 120), add:

```css
  .wsui .usage-panel { padding: 8px 14px; font-size: 12px; border-bottom: 1px solid #f0f0ec; }
  .wsui .usage-total { display: flex; gap: 12px; font-weight: 600; margin-bottom: 6px; }
  .wsui .usage-h { font-weight: 600; margin: 6px 0 2px; color: #666; }
  .wsui .usage-row { display: flex; gap: 12px; align-items: baseline; padding: 1px 0; }
  .wsui .usage-row.sub { padding-left: 10px; color: #555; }
  .wsui .usage-name { min-width: 160px; }
  .wsui .usage-usd { min-width: 64px; text-align: right; }
  .wsui .usage-tok { min-width: 80px; text-align: right; color: #666; }
  .wsui .usage-split { color: #999; font-size: 11px; }
  .wsui .usage-empty { color: #999; }
```

- [ ] **Step 4: Add a Usage button + panel to the Health tab feature rows**

In `apps/mcp-workspace/src/health-ui.ts`, add the import at the top:

```ts
import { renderUsage, type WorkspaceUsage } from "./usage-widget.js";
```

In `renderFeatures`, inside the `for (const f of active)` loop, after the per-container `serviceRow` loop, add a Usage button row + panel:

```ts
      const usagePanel = el("div", "row usage-panel");
      usagePanel.style.display = "none";
      const usageBtn = el("button", "refresh", "Usage") as HTMLButtonElement;
      usageBtn.addEventListener("click", async () => {
        if (usagePanel.style.display !== "none") { usagePanel.style.display = "none"; return; }
        usagePanel.style.display = "";
        usagePanel.textContent = "Computing usage…";
        try {
          const u = (await call("workspace-usage", { name: f.name })) as WorkspaceUsage;
          renderUsage(usagePanel, u);
        } catch {
          usagePanel.textContent = "Failed to load usage.";
        }
      });
      const btnRow = el("div", "row sub");
      btnRow.appendChild(usageBtn);
      host.appendChild(btnRow);
      host.appendChild(usagePanel);
```

`call` and `el` already exist in `health-ui.ts`. The `renderUsage`-injected classes (`.usage-total`, `.usage-row`, etc.) inherit the Health tab's existing row styles; add the same `.usage-*` CSS block from Step 3 to health-ui's style block if the tab has one, otherwise the defaults are legible.

- [ ] **Step 5: Verify the full build**

Run: `cd apps/mcp-workspace && npm run build`
Expected: tsc `--noEmit` passes, vite builds all HTML bundles, server tsc passes — no errors.

- [ ] **Step 6: Manual dashboard verification**

Run the dashboard (`./sandbox connect` if not already up, then open the workspaces dashboard). For a workspace that has had Claude sessions:
1. Workspaces tab → click **Usage** on a card → panel expands with grand total, per-model rows, per-session rows; costliest session shows 🔥. Click again → collapses.
2. Health tab → for an up feature → click **Usage** → same breakdown appears beneath its service rows.
3. A workspace with no sessions shows "No usage recorded … yet."

Expected: numbers are plausible; a model absent from `infra/config/model-pricing.yaml` shows `—` for dollars but still shows tokens.

- [ ] **Step 7: Commit**

```bash
git add apps/mcp-workspace/src/workspace-ui.ts apps/mcp-workspace/src/health-ui.ts
git commit -m "feat(mcp-workspace): surface usage breakdown in Workspaces + Health tabs"
```

---

## Self-Review

**Spec coverage:**
- Reducer summing `message.usage` by model → Task 1 (`reduceUsageLines`, `getWorkspaceUsage`). ✓
- Top-level fields not `iterations[]` → Task 1 reducer comment + only reads named fields. ✓
- Configurable pricing YAML + fallback + unknown→null → Task 1 (`model-pricing.yaml`, `loadPriceTable`, `DEFAULT_PRICES`, `estimateUsd`). ✓
- On-demand, no cache → Tasks 2/4 (button triggers the call; no timer). ✓
- Full breakdown inline (per-model + per-session, hot flag) → Task 3 widget. ✓
- Shared widget in both tabs → Task 3 + Task 4. ✓
- `workspace-usage` MCP tool mirroring `workspace-status` → Task 2. ✓
- Root-project-dir only (no multi-repo sweep) → Task 1 uses `findClaudeProjectDir` exact match; documented in Global Constraints. ✓
- Smoke test on the money path → Task 1 Step 2 + Task 2 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `UsageTotals`/`ModelUsage`/`SessionUsage`/`WorkspaceUsage` field names identical across `lib/sandbox.ts` (Task 1), the tool schema (Task 2), and the widget (Task 3). `getWorkspaceUsage`, `reduceUsageLines`, `estimateUsd` names consistent across tasks. Tool name `"workspace-usage"` consistent in Tasks 2 and 4. ✓
