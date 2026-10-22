#!/usr/bin/env node
/**
 * Fail when a doc names something the code no longer has: a retired term, a
 * repo path that doesn't exist, a `werkmeister` command or flag the CLI doesn't
 * define, or an MCP tool the server doesn't register. See docs/docs-sync.md.
 *
 * Commands and flags come from the built CLI's own `__complete`, so run after
 * `pnpm run build`. A line containing `docs-check: ignore` is skipped, for the
 * mentions that are meant to name the old thing (migration notes, history).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Names and paths that were renamed or removed. A hit is drift unless the line opts out. */
export const RETIRED = [
  [/\bk8s-connect\b/, "`werkmeister connect --k8s`"],
  [/\bk8s-status\b/, "`werkmeister status --k8s`"],
  [/\binfra-up\b/, "`werkmeister up infra`"],
  [/\bworkspace-status\b/, "the `status` MCP tool"],
  [/\bstandards build\b/, "retired; standards render at init-workspace"],
  [/\binfra\/config\//, "`~/.werkmeister/` (services.yaml, ports.yaml)"],
  [/\bworker\.env\b/, "removed with the worker service"],
  [/\bjira\.env\b/, "the `jira:` section of config.yaml"],
  [/(?<!p)npm (run|ci|--prefix)\b/, "pnpm"],
  [/\bpackage-lock\.json\b/, "pnpm-lock.yaml"],
  [/stellwerk/i, "Werkmeister (Stellwerk was a dropped name)"],
];

/** Point-in-time records: they are meant to name things as they were. */
const SKIP = [
  /CHANGELOG\.md$/,
  /^docs\/superpowers\//,
  /^docs\/research\//,
  /^docs\/(naming|context-management)-research\.md$/,
  /^docs\/scamper-/,
];

const PATH_ROOTS = /^(apps|packages|plugins|docs|scripts|\.github)\//;

/** Inline code spans and fenced-block lines, each with its 1-based line number. */
export function codeSpans(text) {
  const spans = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (fenced) spans.push({ line: i + 1, code: line.replace(/(^|\s)#.*$/, ""), block: true });
    else
      for (const m of line.matchAll(/`([^`]+)`/g))
        spans.push({
          line: i + 1,
          code: m[1],
          block: false,
          rest: line.slice(m.index + m[0].length),
        });
  });
  return spans;
}

/**
 * Every problem in one doc. `cli` is { commands: Map<name, Set<flag>> }, `tools`
 * a Set of MCP tool names, `exists`/`read` take repo-relative paths.
 */
export function checkDoc(rel, text, { cli, tools, exists, read }) {
  const problems = [];
  const lines = text.split("\n");
  const ignored = (n) => lines[n - 1].includes("docs-check: ignore");
  const report = (line, msg) => ignored(line) || problems.push(`${rel}:${line}: ${msg}`);

  lines.forEach((l, i) => {
    for (const [re, use] of RETIRED)
      if (re.test(l)) report(i + 1, `retired \`${l.match(re)[0]}\` — use ${use}`);
    for (const m of l.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (!exists(join(dirname(rel), target))) report(i + 1, `broken link ${m[1]}`);
    }
    for (const m of l.matchAll(/mcp__plugin_werkmeister_werkmeister__([a-z][\w-]*)/g))
      if (!tools.has(m[1])) report(i + 1, `unknown MCP tool ${m[1]}`);
    for (const m of l.matchAll(
      /`([a-z][a-z0-9_-]*)` (?:MCP )?tool\b|MCP tools? `([a-z][a-z0-9_-]*)`/g,
    )) {
      const name = m[1] ?? m[2];
      if (!name.includes("__") && !tools.has(name)) report(i + 1, `unknown MCP tool ${name}`);
    }
  });

  for (const { line, code, rest } of codeSpans(text)) {
    // A path pinned to a commit (`… at 66703fc`) names a file deleted since.
    const [p, symbol] = code.replace(/:\d+(-\d+)?$/, "").split("::");
    if (PATH_ROOTS.test(p) && !/[\s*<>{}$]/.test(p) && !/^\s*at [0-9a-f]{7,}/.test(rest ?? "")) {
      if (!exists(p)) report(line, `missing path ${p}`);
      else if (symbol && !read(p).includes(symbol)) report(line, `${p} has no ${symbol}`);
    }
    // ponytail: only flags straight after the command word are checked, so a
    // subcommand's flags (`pr watch --install`) pass unseen. Walk subcommands
    // if those start drifting.
    // A command starts the span or a shell statement; elsewhere it's prose ("werkmeister never…").
    for (const m of code.matchAll(
      /(?:^|[;&|(]\s*|^\s*\$\s+)(?:werkmeister|w9r) ([a-z][\w-]*)((?: --[a-z][\w-]*(?:=\S+)?)*)/g,
    )) {
      const flags = cli.commands.get(m[1]);
      if (!flags) {
        report(line, `unknown command \`werkmeister ${m[1]}\``);
        continue;
      }
      for (const f of m[2].matchAll(/--[a-z][\w-]*/g))
        if (!flags.has(f[0]) && f[0] !== "--help")
          report(line, `unknown flag \`werkmeister ${m[1]} ${f[0]}\``);
    }
  }
  return problems;
}

/** The built CLI's commands and their long flags, asked through `__complete`. */
function loadCli() {
  const main = join(ROOT, "apps/cli/dist/main.js");
  if (!existsSync(main))
    throw new Error("apps/cli/dist/main.js is missing — run `pnpm run build` first");
  const complete = (line) =>
    execFileSync(process.execPath, [main, "__complete"], {
      env: { ...process.env, COMP_LINE: line, COMP_POINT: String(line.length) },
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  const commands = new Map();
  for (const name of complete("werkmeister "))
    commands.set(name, new Set(complete(`werkmeister ${name} --`)));
  return { commands };
}

/** Tool names as the MCP server registers them, plus the plugin's own (`$.tool.register`). */
function loadTools() {
  const dir = join(ROOT, "apps/mcp/src");
  const tools = new Set();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")))
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(
      /register(?:App)?Tool\(\s*(?:server,\s*)?"([^"]+)"/g,
    ))
      tools.add(m[1]);
  const plugin = readFileSync(join(ROOT, "plugins/werkmeister/hooks/register.tsx"), "utf8");
  for (const m of plugin.matchAll(/const \w+_TOOL = "([^"]+)"/g)) tools.add(m[1]);
  return tools;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docs = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !SKIP.some((re) => re.test(f)));
  const ctx = {
    cli: loadCli(),
    tools: loadTools(),
    exists: (p) => existsSync(join(ROOT, p)),
    read: (p) => readFileSync(join(ROOT, p), "utf8"),
  };
  const problems = docs.flatMap((rel) => checkDoc(rel, readFileSync(join(ROOT, rel), "utf8"), ctx));
  for (const p of problems) console.error(p);
  console.log(`${docs.length} docs checked, ${problems.length} problem(s).`);
  process.exit(problems.length ? 1 : 0);
}
