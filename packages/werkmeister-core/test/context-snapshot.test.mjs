// SW-318: close-out's context.json / context.md: peak and % of the window, compactions, the
// first-turn baseline with /context's category breakdown, tool-result tokens and stage-end sizes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  buildContextSnapshot,
  parseContextReport,
  reduceSessionContext,
  renderContextMd,
} from "../dist/context_snapshot.js";

// stage.done events are read from a log of this file's own, never ~/.werkmeister.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "context-home-"));
process.env.WERKMEISTER_CONFIG_FILE = path.join(tmp, "config.yaml");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The layout `claude -p /context --output-format json` prints in .result (Claude Code 2.1.330).
const REPORT = `## Context Usage

**Model:** claude-opus-5-5
**Tokens:** 26.8k / 400k (7%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.8k | 0.7% |
| System tools | 915 | 0.2% |
| MCP tools | 1.2k | 0.3% |
| Memory files | 5.1k | 1.3% |
| Skills | 10k | 2.5% |
| Messages | 3.2k | 0.8% |
| Free space | 340.2k | 85.1% |
| Autocompact buffer | 33k | 8.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__jira__getIssue | jira | 1.5k |
| mcp__jira__search | jira | 500 |
| mcp__docs__read | docs | 800 |

### Custom Agents

| Agent Type | Source | Tokens |
|------------|--------|--------|
| reviewer | Plugin | 87 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| Project | /ws/CLAUDE.md | 1.7k |
| AutoMem | /home/memory/MEMORY.md | 929 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| triage | User | ~100 |
`;

test("parseContextReport reads the window, categories, MCP servers and tools, memory files", () => {
  const b = parseContextReport(REPORT);
  assert.equal(b.model, "claude-opus-5-5");
  assert.equal(b.window, 400_000);
  assert.deepEqual(b.categories.slice(0, 3), [
    { name: "System prompt", tokens: 2800 },
    { name: "System tools", tokens: 915 },
    { name: "MCP tools", tokens: 1200 },
  ]);
  assert.equal(b.categories.at(-1).name, "Autocompact buffer");
  assert.deepEqual(b.mcpServers, [
    { server: "jira", tokens: 2000 },
    { server: "docs", tokens: 800 },
  ]);
  assert.deepEqual(b.mcpTools[0], { tool: "mcp__jira__getIssue", server: "jira", tokens: 1500 });
  assert.deepEqual(b.memoryFiles, [
    { type: "Project", path: "/ws/CLAUDE.md", tokens: 1700 },
    { type: "AutoMem", path: "/home/memory/MEMORY.md", tokens: 929 },
  ]);
  assert.deepEqual(b.agents, [{ name: "reviewer", tokens: 87 }]);
  assert.deepEqual(b.skills, [{ name: "triage", tokens: 100 }]);
});

const MODEL = "claude-opus-5-5";
const assistant = (at, context, toolUses = []) => ({
  type: "assistant",
  timestamp: at,
  message: {
    model: MODEL,
    usage: { input_tokens: 10, cache_read_input_tokens: context - 10, output_tokens: 99 },
    content: toolUses.map(([id, name, input]) => ({ type: "tool_use", id, name, input })),
  },
});
const results = (at, ...parts) => ({
  type: "user",
  timestamp: at,
  message: {
    content: parts.map(([id, content]) => ({ type: "tool_result", tool_use_id: id, content })),
  },
});
const LINES = [
  { type: "user", timestamp: "2026-11-01T10:00:00.000Z", message: { content: "go" } },
  assistant("2026-11-01T10:01:00.000Z", 10_000, [
    ["t1", "Read", { file_path: "/ws/BRIEF.md" }],
    ["t2", "Bash", { command: "git status" }],
  ]),
  results("2026-11-01T10:01:30.000Z", ["t1", "x".repeat(4000)], ["t2", "y".repeat(800)]),
  "not json",
  assistant("2026-11-01T10:02:00.000Z", 60_000, [
    ["t3", "Read", { file_path: "/ws/src/a.ts" }],
    ["t4", "mcp__jira__getIssue", { key: "SW-1" }],
  ]),
  results(
    "2026-11-01T10:02:30.000Z",
    ["t3", "z".repeat(400)],
    [
      "t4",
      [
        { type: "text", text: "w".repeat(2000) },
        { type: "image", source: {} },
      ],
    ],
  ),
  assistant("2026-11-01T10:20:00.000Z", 300_000),
  {
    type: "system",
    subtype: "compact_boundary",
    timestamp: "2026-11-01T10:21:00.000Z",
    compactMetadata: { trigger: "auto", preTokens: 300_000, postTokens: 20_000 },
  },
  assistant("2026-11-01T10:30:00.000Z", 25_000),
];
const TEXT = LINES.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
const STAGES = [
  { stage: "01_research", finishedAt: "2026-11-01T10:10:00.000Z", minutes: 10 },
  { stage: "02_spec", finishedAt: "2026-11-01T10:25:00.000Z", minutes: 15 },
  { stage: "03_implement", finishedAt: null, minutes: null },
];

test("reduceSessionContext: peak, baseline, compaction, per-tool results, stage ends", () => {
  const s = reduceSessionContext(TEXT, "s1", STAGES);
  assert.equal(s.model, MODEL);
  assert.equal(s.turns, 4);
  assert.deepEqual(s.peak, { tokens: 300_000, pct: null, turn: 3, at: "2026-11-01T10:20:00.000Z" });
  assert.deepEqual(s.baseline, { tokens: 10_000, at: "2026-11-01T10:01:00.000Z" });
  assert.deepEqual(s.compactions, [
    {
      turn: 3,
      at: "2026-11-01T10:21:00.000Z",
      stage: "02_spec",
      trigger: "auto",
      before: 300_000,
      after: 20_000,
    },
  ]);
  assert.deepEqual(s.toolResults, [
    { tool: "Read", count: 2, estTokens: 1100 },
    { tool: "mcp__jira__getIssue", count: 1, estTokens: 500 },
    { tool: "Bash", count: 1, estTokens: 200 },
  ]);
  assert.deepEqual(
    s.largestResults.map((r) => [r.tool, r.target, r.estTokens]),
    [
      ["Read", "/ws/BRIEF.md", 1000],
      ["mcp__jira__getIssue", null, 500],
      ["Bash", "git status", 200],
      ["Read", "/ws/src/a.ts", 100],
    ],
  );
  assert.deepEqual(s.stageEnds, [
    { stage: "01_research", tokens: 60_000, at: "2026-11-01T10:10:00.000Z" },
    { stage: "02_spec", tokens: 300_000, at: "2026-11-01T10:25:00.000Z" },
  ]);
  assert.equal(reduceSessionContext(JSON.stringify(LINES[0]), "empty", STAGES), null);
});

/** A temp HOME whose Claude project dir for *ws* holds TEXT, and a fake `claude` on CLAUDE_BIN. */
async function withSession(ws, claudeScript, fn) {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  const dir = path.join(home, ".claude", "projects", ws.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "s1.jsonl"), TEXT);
  const bin = path.join(home, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\n${claudeScript}\n`, { mode: 0o755 });
  const prev = { HOME: process.env.HOME, CLAUDE_BIN: process.env.CLAUDE_BIN };
  Object.assign(process.env, { HOME: home, CLAUDE_BIN: bin });
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(prev))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

function stagedWorkspace() {
  const ws = fs.mkdtempSync(path.join(tmp, "ws-"));
  const out = path.join(ws, "stages", "01_research", "output");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(ws, "stages", "02_spec", "output"), { recursive: true });
  fs.writeFileSync(path.join(out, "inventory.md"), "x");
  // No git and no stage.done event: the stage ends at its output's mtime.
  const t = new Date("2026-11-01T10:10:00.000Z");
  fs.utimesSync(path.join(out, "inventory.md"), t, t);
  return ws;
}

test("buildContextSnapshot: window and % from /context, summary row, baseline breakdown in the md", async () => {
  const ws = stagedWorkspace();
  const json = path.join(tmp, "context.json");
  fs.writeFileSync(json, JSON.stringify({ type: "result", result: REPORT }));
  await withSession(ws, `echo "$@" > "${tmp}/args"; cat "${json}"`, async () => {
    const s = await buildContextSnapshot(ws, "demo", { context_strategy: "icm" }, "shipped");
    assert.equal(s.schema, 1);
    assert.deepEqual(s.summary, {
      sessions: 1,
      maxPeakPct: 75,
      maxPeakTokens: 300_000,
      compactions: 1,
      contextStrategy: "icm",
    });
    assert.equal(s.sessions[0].window, 400_000);
    assert.equal(s.sessions[0].peak.pct, 75);
    assert.deepEqual(
      s.sessions[0].stageEnds.map((e) => e.stage),
      ["01_research"],
    );
    assert.equal(s.baselines[MODEL].memoryFiles.length, 2);
    assert.ok(!s.note);
    assert.equal(
      fs.readFileSync(path.join(tmp, "args"), "utf8").trim(),
      // disableAllHooks: the workspace's SessionEnd hook would otherwise reach the daemon.
      `-p /context --output-format json --no-session-persistence --settings {"disableAllHooks":true} --model ${MODEL}`,
    );
    const md = renderContextMd(s);
    assert.match(md, /^Context: peak 75% \(300\.0K \/ 400\.0K\), 1 compaction across 1 session$/m);
    assert.match(md, /^\| 1 \| 75% \| 300,000 \| 1 \| icm \|$/m);
    // 02_spec has no output yet, so the compaction falls after the last finished stage.
    assert.match(md, /^\| 3 \| 2026-11-01T10:21:00\.000Z \| — \| auto \| 300,000 \| 20,000 \|$/m);
    assert.match(md, /^\| 01_research \| .* \| 60,000 \|$/m);
    assert.match(md, /^\| Read \| 2 \| 1,100 \|$/m);
    assert.match(md, /^\| System prompt \| 2,800 \|$/m);
    assert.match(md, /^\| jira \| 2,000 \|$/m);
    assert.match(md, /^\| Project \| \/ws\/CLAUDE\.md \| 1,700 \|$/m);
  });
});

test("buildContextSnapshot: a failing claude leaves the breakdown out with a note, not an error", async () => {
  const ws = stagedWorkspace();
  await withSession(ws, "echo nope >&2; exit 1", async () => {
    const s = await buildContextSnapshot(ws, "demo", {}, "abandoned");
    assert.equal(s.baselines[MODEL], null);
    assert.equal(s.sessions[0].peak.pct, null);
    assert.equal(s.summary.maxPeakPct, null);
    assert.equal(s.summary.contextStrategy, null);
    assert.match(s.note, /^context breakdown not read: claude exited 1: nope$/);
    const md = renderContextMd(s);
    assert.match(md, /^Context: peak 300\.0K, 1 compaction across 1 session$/m);
    assert.match(md, /^Not read\.$/m);
  });
});
