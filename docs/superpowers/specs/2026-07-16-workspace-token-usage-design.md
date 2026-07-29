# Per-workspace token & model usage

**Date:** 2026-07-16
**Status:** Approved, ready for planning

## Problem

We want to see how many tokens each sandbox workspace's Claude Code agents
have consumed, split by model, with a rough dollar estimate. This serves four
overlapping needs the user confirmed: cost awareness, spotting runaway
sessions, auditing which model a workspace actually ran, and general
visibility.

No new instrumentation is required. Claude Code already writes every assistant
turn to a session JSONL under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`,
and each assistant line carries `message.model` plus `message.usage`
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`). Because the encoded dir *is* the workspace path,
usage is already partitioned per workspace. The feature is a reducer over files
the dashboard already reads, surfaced on demand.

## Approach

On-demand, no caching, no auto-scan. A **"Usage" button** on each workspace row
(in both dashboard tabs) triggers a scan; the result renders as a full
breakdown inline. This was chosen over live/cached scanning because summing a
workspace's transcripts means reading every line of every session JSONL (tens
of MB for active workspaces), and the Health tab auto-refreshes on a timer —
on-demand avoids that cost entirely with no cache machinery.

### Data flow

```
[Usage btn]  →  bridge.callTool("workspace-usage", { name })
                     │
   server.ts  →  getWorkspaceUsage(name)          (new, in lib/sandbox.ts)
                     │  resolveWorkspaceDir → findClaudeProjectDir → listSessionFiles   (all existing)
                     │  new reducer: read each *.jsonl, sum message.usage by message.model
                     ▼
                WorkspaceUsage  →  renderUsage(container, summary)   (new shared widget)
```

The file-finding chain (`resolveWorkspaceDir` → `findClaudeProjectDir` →
`listSessionFiles`) already exists in `lib/sandbox.ts` and is the same chain the
chat panel and transcript tools use. Reusing it means usage counts exactly the
sessions the dashboard already associates with a workspace.

## Components

### 1. Reducer — `getWorkspaceUsage(name)` (new, `apps/mcp-workspace/lib/sandbox.ts`)

`parseSessionLines()` deliberately discards `usage`/`model` (it keeps only
role/text/timestamp), so this is a separate small pass over the same files.

```ts
interface UsageTotals {
  input: number;          // input_tokens
  output: number;         // output_tokens
  cacheCreation: number;  // cache_creation_input_tokens
  cacheRead: number;      // cache_read_input_tokens
}

interface ModelUsage {
  model: string;
  totals: UsageTotals;
  estUsd: number | null;  // null if model not in price table
}

interface SessionUsage {
  sessionId: string;
  title: string;          // reuse readSessionTitle()
  updatedAt: string;      // ISO, file mtime
  totals: UsageTotals;
  estUsd: number | null;
}

interface WorkspaceUsage {
  name: string;
  totals: UsageTotals;        // grand total across all sessions
  estUsd: number | null;      // sum of priced-model estimates; null if nothing priced
  byModel: ModelUsage[];      // sorted by estUsd desc, then tokens desc
  sessions: SessionUsage[];   // newest first
}
```

Per line: `JSON.parse`, keep `type === "assistant"`, read `message.model` and
`message.usage`, accumulate into per-model and per-session totals. Sum the
**top-level** `usage` fields only — NOT `usage.iterations[]`, which itemizes a
single tool-loop turn and would double-count. Unparseable lines are skipped.

When the workspace has no project dir / no sessions, return zeroed totals with
empty `byModel`/`sessions` and `estUsd: null` (the widget shows "no usage yet").

### 2. Pricing config (new, `infra/config/model-pricing.yaml`)

Rates live in a YAML config file so models can be added/repriced without a code
change. It's resolved by a `resolveModelPricingYaml()` helper mirroring the
existing `resolveServicesYaml()`: `$SANDBOX_MODEL_PRICING_YAML` override → walk
up from the module to the repo root that owns `infra/config/model-pricing.yaml`.
Parsed with the `yaml` dep the app already depends on. Shape:

```yaml
# per-million-token USD rates
models:
  claude-opus-4-8:   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 }
  claude-sonnet-5:   { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.30 }
  claude-haiku-4-5:  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.10 }
```

Cost per model:

```
est = input/1e6 * inRate
    + output/1e6 * outRate
    + cacheCreation/1e6 * cacheWriteRate
    + cacheRead/1e6 * cacheReadRate
```

A bundled default table in code is the fallback when the file is missing or
unparseable, so the feature works out of the box; editing the YAML overrides
it. An unknown model (in neither file nor fallback) → tokens still shown,
`estUsd: null` (no guessed dollars). The config is read once per
`getWorkspaceUsage()` call — on-demand, so no cache needed. Rates are seeded
with current published per-MTok pricing at implementation time.

### 3. Shared widget — `renderUsage(container, summary)` (new, `apps/mcp-workspace/src/usage-widget.ts`)

Dependency-free vanilla DOM with its own local `el()` helper (the tabs don't
share one — health-ui.ts and workspace-ui.ts each define their own). Renders:

- Grand-total line: `~$X.XX · N.NM tok` (dollars omitted if `estUsd` is null).
- Per-model table: model, tokens (with in/out/cache-read split), `~$`.
- Per-session list, newest first: title, `~$`, tokens; the highest-cost
  session gets a small "hot" flag so a runaway stands out.

Token counts are formatted compactly (e.g. `1.2M`, `980K`). Dollars show `~`
prefix to signal estimate.

### 4. MCP tool — `workspace-usage` (new, `apps/mcp-workspace/server.ts`)

`registerTool("workspace-usage", …)` mirroring the existing `workspace-status`
registration: input `{ name: z.string() }`, zod-typed `structuredContent`
matching `WorkspaceUsage`, plus a plain-text fallback summary (grand total +
per-model one-liners) for non-UI MCP callers. Wrap in the same
`WorkspaceError`/try-catch shape as the sibling tools.

### 5. Wiring (edits, `src/workspace-ui.ts` + `src/health-ui.ts`)

Each tab adds a "Usage" button per workspace row and a collapsible container.
On click: `bridge.callTool("workspace-usage", { name })` → `renderUsage(container, result)`,
toggling the panel. Health tab's rows are keyed by feature name (only up
features); Workspaces tab covers all workspaces. Same widget, same call, two
mount points.

## Testing

One `apps/mcp-workspace/lib/usage.smoke.mjs` (matches the existing
`*.smoke.mjs` convention). The line-reducer and the cost function are exported
as pure helpers (reducer takes a pricing map as an argument; `estimateUsd(totals, rate)`
is standalone) so the test needs no filesystem. Feed a tiny synthetic JSONL
string with two assistant lines across two models (including cache tokens) plus
a fixed pricing map, and assert: per-model totals, grand total, the dollar math
for a priced model, and `null` for a model absent from the map. This is the
runnable check on the money path.

## Out of scope (deliberately)

- **Multi-repo subdir sessions.** If Claude Code is launched from a repo dir
  *inside* the workspace rather than the workspace root, that session lands in
  a different encoded project dir and is not counted. This matches existing
  session tooling behavior (chat panel, transcript). Add a prefix-match sweep
  over `~/.claude/projects/` if this turns out common.
- **Caching / live updates.** On-demand computation covers all stated needs.
- **Dollar cost for unknown models.** Tokens only; no guessed rates.

## Files

| File | Change |
|------|--------|
| `apps/mcp-workspace/lib/sandbox.ts` | + `getWorkspaceUsage()`, usage types, reducer, `resolveModelPricingYaml()` + fallback table |
| `infra/config/model-pricing.yaml` | new — configurable per-MTok rates |
| `apps/mcp-workspace/src/usage-widget.ts` | new — shared `renderUsage()` |
| `apps/mcp-workspace/server.ts` | + `workspace-usage` tool registration |
| `apps/mcp-workspace/src/workspace-ui.ts` | + Usage button/panel per row |
| `apps/mcp-workspace/src/health-ui.ts` | + Usage button/panel per row |
| `apps/mcp-workspace/lib/usage.smoke.mjs` | new — reducer + pricing smoke test |
