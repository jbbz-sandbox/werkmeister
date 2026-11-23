/**
 * The context snapshot close-out leaves beside usage.md (SW-318): `context.json` for tools (the
 * SW-403 metrics board), `context.md` for people. How full each session's context window got, what
 * filled it and when it compacted; like usage.md, the transcripts are gone once the folder is.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveClaudeBin } from "./harness/claude/cli.js";
import { findClaudeProjectDir, listSessionFiles } from "./harness/claude/transcript.js";
import { reduceSession } from "./harness/claude/usage.js";
import { issueIdOf } from "./issue_tracker.js";
import { runCapture } from "./tool_bins.js";
// biome-ignore lint/suspicious/noImportCycles: pr_lifecycle↔sandbox.ts↔usage_snapshot; SW-411
import { formatTokens, type StageTiming, stageTimings } from "./usage_snapshot.js";

export interface ContextBaseline {
  model: string | null;
  window: number | null;
  categories: Array<{ name: string; tokens: number }>;
  mcpServers: Array<{ server: string; tokens: number }>;
  mcpTools: Array<{ tool: string; server: string; tokens: number }>;
  memoryFiles: Array<{ type: string; path: string; tokens: number }>;
  agents: Array<{ name: string; tokens: number }>;
  skills: Array<{ name: string; tokens: number }>;
}

export interface Compaction {
  turn: number;
  at: string | null;
  stage: string | null;
  trigger: string | null;
  before: number | null;
  after: number | null;
}

export interface SessionContext {
  sessionId: string;
  model: string | null;
  turns: number;
  window: number | null;
  peak: { tokens: number; pct: number | null; turn: number; at: string | null };
  baseline: { tokens: number; at: string | null };
  compactions: Compaction[];
  toolResults: Array<{ tool: string; count: number; estTokens: number }>;
  largestResults: Array<{
    tool: string;
    target: string | null;
    estTokens: number;
    at: string | null;
  }>;
  stageEnds: Array<{ stage: string; tokens: number; at: string }>;
}

export interface ContextSnapshot {
  schema: 1;
  workspace: string;
  ticket: string | null;
  outcome: "shipped" | "abandoned";
  closedAt: string;
  summary: {
    sessions: number;
    maxPeakPct: number | null;
    maxPeakTokens: number;
    compactions: number;
    contextStrategy: string | null;
  };
  /** Keyed by session model; null when `/context` could not be read for it. */
  baselines: Record<string, ContextBaseline | null>;
  sessions: SessionContext[];
  note?: string;
}

const NO_TRANSCRIPTS = "no Claude Code transcripts found for this workspace";
const LARGEST = 10;

/** `/context` counts: `741`, `2.8k`, `~100`, `1m`. */
function parseCount(s: string): number | null {
  const m = /^~?([\d.]+)\s*([km]?)$/i.exec(s.trim());
  if (!m) return null;
  const mult = { "": 1, k: 1e3, m: 1e6 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

/** Parse the markdown `claude -p /context` prints (Claude Code 2.1.330's layout). */
export function parseContextReport(md: string): ContextBaseline {
  const sections = new Map<string, string[][]>();
  let rows: string[][] | null = null;
  for (const line of md.split("\n")) {
    const h = /^###\s+(.*)$/.exec(line);
    if (h) sections.set(h[1]?.trim() ?? "", (rows = []));
    else if (rows && line.startsWith("|") && !/^\|[\s|:-]+\|$/.test(line))
      rows.push(
        line
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim()),
      );
  }
  // Each table's first row is its header.
  const table = (name: string) => (sections.get(name) ?? []).slice(1);
  const counted = <T>(name: string, at: number, make: (r: string[], tokens: number) => T) =>
    table(name).flatMap((r) => {
      const n = parseCount(r[at] ?? "");
      return n == null ? [] : [make(r, n)];
    });
  const tokensLine = /\*\*Tokens:\*\*\s*\S+\s*\/\s*(\S+)/.exec(md);
  const mcpTools = counted("MCP Tools", 2, (r, tokens) => ({
    tool: r[0] ?? "",
    server: r[1] ?? "",
    tokens,
  }));
  const servers = new Map<string, number>();
  for (const t of mcpTools) servers.set(t.server, (servers.get(t.server) ?? 0) + t.tokens);
  return {
    model: /\*\*Model:\*\*\s*(\S+)/.exec(md)?.[1] ?? null,
    window: tokensLine?.[1] ? parseCount(tokensLine[1]) : null,
    categories: counted("Estimated usage by category", 1, (r, tokens) => ({
      name: r[0] ?? "",
      tokens,
    })),
    mcpServers: [...servers]
      .map(([server, tokens]) => ({ server, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    mcpTools,
    memoryFiles: counted("Memory Files", 2, (r, tokens) => ({
      type: r[0] ?? "",
      path: r[1] ?? "",
      tokens,
    })),
    agents: counted("Custom Agents", 2, (r, tokens) => ({ name: r[0] ?? "", tokens })),
    skills: counted("Skills", 2, (r, tokens) => ({ name: r[0] ?? "", tokens })),
  };
}

interface Part {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

// shortcut: chars/4, no tokenizer is installed; swap in one if the per-tool split needs to be exact.
const estTokens = (content: unknown): number => {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p: Part) => (p?.type === "text" ? (p.text ?? "") : "")).join("")
        : "";
  return Math.ceil(text.length / 4);
};

function targetOf(input: Record<string, unknown> | undefined): string | null {
  for (const k of ["file_path", "command", "pattern", "url", "description"]) {
    const v = input?.[k];
    if (typeof v === "string" && v) return v.slice(0, 80);
  }
  return null;
}

/** One transcript's context figures, with no window known yet; null when it has no usage turn. */
export function reduceSessionContext(
  text: string,
  sessionId: string,
  stages: StageTiming[],
): SessionContext | null {
  const turns: Array<{ tokens: number; at: string | null }> = [];
  const models = new Map<string, number>();
  const compactions: Compaction[] = [];
  const uses = new Map<string, { name: string; input?: Record<string, unknown> }>();
  const byTool = new Map<string, { count: number; estTokens: number }>();
  const results: SessionContext["largestResults"] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: {
      type?: string;
      subtype?: string;
      timestamp?: string;
      compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
      message?: { model?: string; usage?: Record<string, number>; content?: unknown };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof e.timestamp === "string" ? e.timestamp : null;
    const parts = Array.isArray(e.message?.content) ? (e.message.content as Part[]) : [];
    if (e.type === "assistant") {
      for (const p of parts)
        if (p?.type === "tool_use" && p.id)
          uses.set(p.id, { name: p.name ?? "unknown", input: p.input });
      const u = e.message?.usage;
      const model = e.message?.model;
      if (!u || !model) continue;
      models.set(model, (models.get(model) ?? 0) + 1);
      turns.push({
        tokens:
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0),
        at,
      });
    } else if (e.type === "system" && e.subtype === "compact_boundary") {
      const m = e.compactMetadata ?? {};
      compactions.push({
        turn: turns.length,
        at,
        stage: (at && stages.find((s) => s.finishedAt && s.finishedAt > at)?.stage) || null,
        trigger: m.trigger ?? null,
        before: m.preTokens ?? null,
        after: m.postTokens ?? null,
      });
    } else if (e.type === "user") {
      for (const p of parts) {
        if (p?.type !== "tool_result") continue;
        const use = uses.get(p.tool_use_id ?? "");
        const tool = use?.name ?? "unknown";
        const n = estTokens(p.content);
        const t = byTool.get(tool) ?? { count: 0, estTokens: 0 };
        t.count++;
        t.estTokens += n;
        byTool.set(tool, t);
        results.push({ tool, target: targetOf(use?.input), estTokens: n, at });
      }
    }
  }
  const first = turns[0];
  if (!first) return null;
  let peak = 0;
  turns.forEach((t, i) => {
    if (t.tokens > (turns[peak]?.tokens ?? 0)) peak = i;
  });
  const firstAt = turns.find((t) => t.at)?.at ?? null;
  const lastAt = turns.filter((t) => t.at).at(-1)?.at ?? null;
  const stageEnds = stages.flatMap(({ stage, finishedAt }) => {
    if (!finishedAt || !firstAt || !lastAt || finishedAt < firstAt || finishedAt > lastAt)
      return [];
    const last = turns.filter((t) => t.at && t.at <= finishedAt).at(-1);
    return last ? [{ stage, tokens: last.tokens, at: finishedAt }] : [];
  });
  return {
    sessionId,
    model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    turns: turns.length,
    window: null,
    peak: {
      tokens: turns[peak]?.tokens ?? 0,
      pct: null,
      turn: peak + 1,
      at: turns[peak]?.at ?? null,
    },
    baseline: { tokens: first.tokens, at: first.at },
    compactions,
    toolResults: [...byTool]
      .map(([tool, t]) => ({ tool, ...t }))
      .sort((a, b) => b.estTokens - a.estTokens),
    largestResults: results.sort((a, b) => b.estTokens - a.estTokens).slice(0, LARGEST),
    stageEnds,
  };
}

/**
 * `/context` for *model* in *ws*: free (no model turn); --no-session-persistence leaves no
 * transcript, and disableAllHooks keeps the workspace's SessionEnd hook from asking the daemon to
 * stop its containers mid close-out.
 */
// shortcut: runCapture's fixed 120 s timeout per model, run one after another; add a shorter timeout if a hung claude stalls close-outs.
async function readBaseline(ws: string, model: string): Promise<ContextBaseline> {
  const r = await runCapture(
    await resolveClaudeBin(),
    [
      "-p",
      "/context",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--settings",
      '{"disableAllHooks":true}',
      "--model",
      model,
    ],
    ws,
  );
  if (r.code !== 0)
    throw new Error(`claude exited ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
  const report = JSON.parse(r.stdout)?.result;
  if (typeof report !== "string" || !report.includes("**Tokens:**"))
    throw new Error("no /context report in claude's output");
  return parseContextReport(report);
}

const pctOf = (tokens: number, window: number | null) =>
  window ? Math.round((1000 * tokens) / window) / 10 : null;

export async function buildContextSnapshot(
  ws: string,
  name: string,
  cfg: Record<string, unknown>,
  outcome: ContextSnapshot["outcome"],
  closedAt = new Date().toISOString(),
): Promise<ContextSnapshot> {
  const sessions: SessionContext[] = [];
  const baselines: ContextSnapshot["baselines"] = {};
  let note: string | undefined;
  try {
    const dir = await findClaudeProjectDir(ws);
    const files = dir ? await listSessionFiles(dir) : [];
    const texts = files.map((f) => ({
      id: path.basename(f.file, ".jsonl"),
      text: fs.readFileSync(f.file, "utf8"),
    }));
    // The same first turn usage.md's stage clock starts from.
    const firstTurn =
      texts
        .map((t) => reduceSession(t.text))
        .filter((r) => r.turns)
        .flatMap((r) => r.firstTurn ?? [])
        .sort()[0] ?? null;
    const stages = stageTimings(ws, firstTurn);
    for (const { id, text } of texts) {
      const s = reduceSessionContext(text, id, stages);
      if (s) sessions.push(s);
    }
    for (const model of new Set(sessions.map((s) => s.model).filter((m): m is string => !!m))) {
      try {
        baselines[model] = await readBaseline(ws, model);
      } catch (e) {
        baselines[model] = null;
        note ??= `context breakdown not read: ${(e as Error).message}`;
      }
    }
    for (const s of sessions) {
      s.window = (s.model && baselines[s.model]?.window) || null;
      s.peak.pct = pctOf(s.peak.tokens, s.window);
    }
  } catch (e) {
    // Close-out must not fail over a report.
    note = `context not read: ${(e as Error).message}`;
  }
  if (!sessions.length) note ??= NO_TRANSCRIPTS;
  const pcts = sessions.map((s) => s.peak.pct).filter((p): p is number => p != null);
  const strategy = cfg["context_strategy"];
  return {
    schema: 1,
    workspace: name,
    ticket: issueIdOf(cfg) || null,
    outcome,
    closedAt,
    summary: {
      sessions: sessions.length,
      maxPeakPct: pcts.length ? Math.max(...pcts) : null,
      maxPeakTokens: Math.max(0, ...sessions.map((s) => s.peak.tokens)),
      compactions: sessions.reduce((n, s) => n + s.compactions.length, 0),
      contextStrategy: typeof strategy === "string" && strategy ? strategy : null,
    },
    baselines,
    sessions,
    ...(note ? { note } : {}),
  };
}

export function contextSummary(s: ContextSnapshot): string {
  if (!s.summary.sessions) return "Context: no transcripts found";
  const top = [...s.sessions].sort((a, b) => b.peak.tokens - a.peak.tokens)[0];
  const peak =
    top?.peak.pct != null && top.window
      ? `peak ${top.peak.pct}% (${formatTokens(top.peak.tokens)} / ${formatTokens(top.window)})`
      : `peak ${formatTokens(s.summary.maxPeakTokens)}`;
  const n = s.summary.compactions;
  const k = s.summary.sessions;
  return `Context: ${peak}, ${n} compaction${n === 1 ? "" : "s"} across ${k} session${k === 1 ? "" : "s"}`;
}

export function renderContextMd(s: ContextSnapshot): string {
  const cell = (v: unknown) =>
    v === null || v === undefined || v === "" ? "—" : String(v).replace(/\|/g, "\\|");
  const n = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-US"));
  const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
  const table = (head: string, rows: string[]) =>
    rows.length ? [head, ...rows, ""] : ["None.", ""];
  const sum = s.summary;
  const out = [
    "# Context",
    "",
    contextSummary(s),
    "",
    "## Summary",
    "",
    "| sessions | max peak % | max peak tokens | compactions | context_strategy |",
    "|---|---|---|---|---|",
    `| ${sum.sessions} | ${pct(sum.maxPeakPct)} | ${n(sum.maxPeakTokens)} | ${sum.compactions} | ${cell(sum.contextStrategy)} |`,
    "",
    ...(s.note ? [`Note: ${s.note}`, ""] : []),
    "## Sessions",
    "",
    ...table(
      "| session | model | turns | window | baseline | peak | peak % | peak turn | compactions |\n|---|---|---|---|---|---|---|---|---|",
      s.sessions.map(
        (x) =>
          `| ${x.sessionId} | ${cell(x.model)} | ${x.turns} | ${n(x.window)} | ${n(x.baseline.tokens)} | ${n(x.peak.tokens)} | ${pct(x.peak.pct)} | ${x.peak.turn} | ${x.compactions.length} |`,
      ),
    ),
  ];
  for (const x of s.sessions)
    out.push(
      `## Session ${x.sessionId}`,
      "",
      "### Compactions",
      "",
      ...table(
        "| turn | at | stage | trigger | before | after |\n|---|---|---|---|---|---|",
        x.compactions.map(
          (c) =>
            `| ${c.turn} | ${cell(c.at)} | ${cell(c.stage)} | ${cell(c.trigger)} | ${n(c.before)} | ${n(c.after)} |`,
        ),
      ),
      "### Context at stage end",
      "",
      ...table(
        "| stage | finished | context |\n|---|---|---|",
        x.stageEnds.map((e) => `| ${e.stage} | ${e.at} | ${n(e.tokens)} |`),
      ),
      "### Tool results by tool (est. tokens)",
      "",
      ...table(
        "| tool | results | est. tokens |\n|---|---|---|",
        x.toolResults.map((t) => `| ${cell(t.tool)} | ${t.count} | ${n(t.estTokens)} |`),
      ),
      "### Largest results",
      "",
      ...table(
        "| tool | target | est. tokens | at |\n|---|---|---|---|",
        x.largestResults.map(
          (r) => `| ${cell(r.tool)} | ${cell(r.target)} | ${n(r.estTokens)} | ${cell(r.at)} |`,
        ),
      ),
    );
  for (const [model, b] of Object.entries(s.baselines)) {
    out.push(`## Baseline breakdown: ${model} (from /context at close-out)`, "");
    if (!b) {
      out.push("Not read.", "");
      continue;
    }
    const rows = (head: string, list: Array<{ cells: unknown[]; tokens: number }>) =>
      table(
        head,
        list.map((r) => `| ${r.cells.map(cell).join(" | ")} | ${n(r.tokens)} |`),
      );
    out.push(
      `Window: ${n(b.window)}`,
      "",
      "### Categories",
      "",
      ...rows(
        "| category | tokens |\n|---|---|",
        b.categories.map((r) => ({ cells: [r.name], tokens: r.tokens })),
      ),
      "### MCP servers",
      "",
      ...rows(
        "| server | tokens |\n|---|---|",
        b.mcpServers.map((r) => ({ cells: [r.server], tokens: r.tokens })),
      ),
      "### MCP tools",
      "",
      ...rows(
        "| tool | server | tokens |\n|---|---|---|",
        b.mcpTools.map((r) => ({ cells: [r.tool, r.server], tokens: r.tokens })),
      ),
      "### Memory files",
      "",
      ...rows(
        "| type | path | tokens |\n|---|---|---|",
        b.memoryFiles.map((r) => ({ cells: [r.type, r.path], tokens: r.tokens })),
      ),
      "### Custom agents",
      "",
      ...rows(
        "| agent | tokens |\n|---|---|",
        b.agents.map((r) => ({ cells: [r.name], tokens: r.tokens })),
      ),
      "### Skills",
      "",
      ...rows(
        "| skill | tokens |\n|---|---|",
        b.skills.map((r) => ({ cells: [r.name], tokens: r.tokens })),
      ),
    );
  }
  return out.join("\n");
}

/**
 * Write `context.json` + `context.md` into *ws* and return the closeout.md line. A retry keeps the
 * first snapshot, as usage.json does.
 */
export async function writeContextSnapshot(
  ws: string,
  name: string,
  cfg: Record<string, unknown>,
  outcome: ContextSnapshot["outcome"],
): Promise<string> {
  const jsonFile = path.join(ws, "context.json");
  if (fs.existsSync(jsonFile)) {
    try {
      return `${contextSummary(JSON.parse(fs.readFileSync(jsonFile, "utf8")))}; see context.md`;
    } catch {
      return "Context: see context.md";
    }
  }
  const snapshot = await buildContextSnapshot(ws, name, cfg, outcome);
  fs.writeFileSync(path.join(ws, "context.md"), renderContextMd(snapshot));
  fs.writeFileSync(jsonFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return `${contextSummary(snapshot)}; see context.md`;
}
