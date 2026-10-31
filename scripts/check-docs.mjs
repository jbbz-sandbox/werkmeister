#!/usr/bin/env node
/**
 * Fail when a doc names something the code no longer has: a retired term, a
 * repo path that doesn't exist, a `werkmeister` command or flag
 * the CLI doesn't define, an MCP tool the server doesn't register, a bare
 * `<placeholder>` GitHub would drop, a `#anchor` no heading defines, or a
 * generated region that `docs:gen` would rewrite. See docs/docs-sync.md.
 *
 * Commands and flags come from the built CLI's own `__reference`, so run after
 * `pnpm run build`. A line containing `docs-check: ignore` is skipped, for the
 * mentions that are meant to name the old thing (migration notes, history).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_PACKAGE,
  cliReference,
  fill,
  loadRegions,
  MAN_DIR,
  manPages,
  mcpSource,
  mcpTools,
  REGION,
  withMan,
} from "./gen-docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Names and paths that were renamed or removed. A hit is drift unless the line opts out. */
export const RETIRED = [
  [/\bk8s-connect\b/, "`werkmeister infra connect --k8s`"],
  [/\bk8s-status\b/, "`werkmeister infra status`"],
  [/\binfra-up\b/, "`werkmeister infra up`"],
  [/\bworkspace-status\b/, "the `status` MCP tool"],
  [/\bstandards build\b/, "retired; standards render at init-workspace"],
  [/\binfra\/config\//, "`~/.werkmeister/` (services.yaml, ports.yaml)"],
  [/\bworker\.env\b/, "removed with the worker service"],
  [/\bjira\.env\b/, "the `jira:` section of config.yaml"],
  [/(?<!p)npm (run|ci|--prefix)\b/, "pnpm"],
  [/\bpackage-lock\.json\b/, "pnpm-lock.yaml"],
  [/stellwerk/i, "Werkmeister (Stellwerk was a dropped name)"],
  [
    /\b(?:apps\/(?:mcp|sandbox-dashboard)|packages\/(?:sandbox-core|sandbox-ui|vscode-plugin))(?![\w-])/, // name-check: ignore
    "the `werkmeister-*` directory (SW-30)",
  ],
  // SW-186's noun groups. Only a command (after a backtick, `$ ` or `&&`), not prose.
  ...Object.entries({
    up: "feature up` or `infra up",
    down: "feature down` or `infra down",
    restart: "feature restart` or `infra restart",
    stop: "feature stop`, `infra stop`, `internal session-end` or `internal reap",
    status: "feature status` or `infra status",
    pause: "feature pause",
    resume: "feature resume",
    services: "feature services",
    logs: "feature logs",
    remove: "feature drop",
    test: "feature test",
    open: "feature open",
    connect: "infra connect",
    "proxy-reload": "infra proxy-reload",
    intercept: "infra intercept",
    "init-workspace": "workspace init",
    "list-workspaces": "workspace list",
    "close-out": "workspace close` or `workspace abandon",
    "remove-workspace": "workspace abandon",
    code: "workspace code",
    "starting-prompt": "workspace prompt",
    "start-args": "workspace prompt --args",
    "wait-load": "internal wait-load",
    hooks: "internal gate`, `internal pr-guard` or `internal agent-state",
    setup: "machine setup",
    config: "machine config",
    detect: "machine detect",
    migrate: "machine migrate",
    clean: "machine clean",
    stats: "machine stats",
    optimize: "machine optimize",
    mcp: "internal mcp",
    dashboard: "internal dashboard",
  }).map(([old, now]) => [
    new RegExp(`(?<=\`|\\$ |&& )(?:werkmeister|w9r) ${old}(?![\\w.-])`),
    `\`werkmeister ${now}\` (SW-186)`,
  ]),
];

/** Each man page in `dir` that differs from `pages` (what `docs:gen` writes), is missing, or has no command. */
export function checkMan(pages, dir) {
  const have = existsSync(dir) ? readdirSync(dir) : [];
  const at = (f) => relative(ROOT, join(dir, f));
  return [
    ...Object.entries(pages)
      .filter(([f, text]) => !have.includes(f) || readFileSync(join(dir, f), "utf8") !== text)
      .map(([f]) => `${at(f)}: out of date, run \`pnpm run docs:gen\``),
    ...have
      .filter((f) => !(f in pages))
      .map((f) => `${at(f)}: no such command, run \`pnpm run docs:gen\``),
  ];
}

/** Point-in-time records: they are meant to name things as they were. */
const SKIP = [
  /CHANGELOG\.md$/,
  /^docs\/superpowers\//,
  /^docs\/research\//,
  /^docs\/(naming|context-management)-research\.md$/,
  /^docs\/scamper-/,
  // SW-180: written to read from docs/users-guide.md, where gen-docs renders them and this checks them.
  /\.help\.md$/,
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
 * a Set of MCP tool names, `regions` docs:gen's Markdown by region name,
 * `exists`/`read` take repo-relative paths.
 */
export function checkDoc(rel, text, { cli, tools, regions, exists, read }) {
  const problems = [];
  const lines = text.split("\n");
  const ignored = (n) => lines[n - 1].includes("docs-check: ignore");
  const report = (line, msg) => ignored(line) || problems.push(`${rel}:${line}: ${msg}`);
  // A retired name in a generated region is the source's own (a deny rule, help naming what
  // a command replaced); checkGenerated already holds the region to that source.
  const generated = new Set();
  for (const m of text.matchAll(REGION)) {
    const first = text.slice(0, m.index).split("\n").length;
    for (let n = first; n < first + m[0].split("\n").length; n++) generated.add(n);
  }

  lines.forEach((l, i) => {
    for (const [re, use] of RETIRED)
      if (re.test(l) && !generated.has(i + 1))
        report(i + 1, `retired \`${l.match(re)[0]}\` — use ${use}`);
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
    checkCommands(line, code, cli, report);
  }
  checkPlaceholders(text, report);
  checkAnchors(rel, text, read, exists, report);
  checkGenerated(text, regions, report);
  return problems;
}

/** A region whose body isn't what docs:gen writes: hand-edited, or its source moved on. */
export function checkGenerated(text, regions, report) {
  if (!text.includes("<!-- generated:")) return;
  const { problems } = fill(text, regions);
  for (const p of problems) report(p.line, p.msg);
  for (const m of text.matchAll(REGION))
    if (m[1] in regions && fill(m[0], regions).text !== m[0])
      report(
        text.slice(0, m.index).split("\n").length,
        `generated region \`${m[1]}\` is out of date — run \`pnpm run docs:gen\``,
      );
}

/**
 * `werkmeister` or `w9r` where a command starts the span or a shell statement, elsewhere it's prose
 * ("werkmeister never…"). Every `--flag` up to the statement's end or a bare
 * `--` is checked against the command's own set: `pr watch` and `cache prune`
 * are `<action>` positionals, so their flags hang on `pr` and `cache`.
 */
export function checkCommands(line, code, cli, report) {
  for (const m of code.matchAll(
    /(?:^|[;&|(]\s*|^\s*\$\s+)(werkmeister|w9r) ([a-z][\w-]*)([^;&|()]*)/g,
  )) {
    // SW-186: `<noun> <verb>` names one command, with its own flags.
    // `ws` is `workspace`'s alias; a permission rule's verb ends in `:*`.
    const noun = m[2] === "ws" ? "workspace" : m[2];
    const verb = m[3].trim().match(/^[a-z][\w-]*/)?.[0];
    const name = cli.commands.has(`${noun} ${verb}`) ? `${noun} ${verb}` : m[2];
    const flags = cli.commands.get(name);
    if (!flags) {
      report(line, `unknown command \`${m[1]} ${m[2]}\``);
      continue;
    }
    const args = m[3].replace(/"[^"]*"|'[^']*'/g, "").split(/\s+/);
    const end = args.indexOf("--");
    for (const arg of end < 0 ? args : args.slice(0, end)) {
      const flag = arg.match(/^--[a-z][\w-]*/)?.[0];
      if (flag && !flags.has(flag) && flag !== "--help")
        report(line, `unknown flag \`${m[1]} ${name} ${flag}\``);
    }
  }
}

/** Lines with fenced blocks blanked, so index + 1 stays the line number. */
function unfenced(text) {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) return line;
    return "";
  });
}

/** The elements GitHub keeps; any other `<tag …>` it strips without a trace. */
const HTML_TAGS = new Set(
  "a abbr b bdo blockquote br caption cite code dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q rp rt ruby s samp small source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var video wbr".split(
    " ",
  ),
);

/** A `<placeholder>` outside code: GitHub reads it as an unknown HTML tag and drops it. */
export function checkPlaceholders(text, report) {
  const blank = (m) => m.replace(/[^\n]/g, "");
  const prose = unfenced(text)
    .join("\n")
    .replace(/^---\n[\s\S]*?\n---\n/, blank)
    // A code span may wrap a line, but never crosses a blank one.
    .replace(/<!--[\s\S]*?-->|(`+)(?:(?!\n\s*\n)[\s\S])*?\1/g, blank);
  prose.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/(?<!\\)<([a-z][a-z0-9-]*)(?:\s[^<>]*)?\/?>/gi))
      if (!HTML_TAGS.has(m[1].toLowerCase()))
        report(i + 1, `bare placeholder \`${m[0]}\` (GitHub drops it); put it in a code span`);
  });
}

/** GitHub's heading id: link text kept, punctuation dropped, lowercased, spaces to hyphens. */
export function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "")
    .replace(/ /g, "-");
}

/** Every `#id` a doc defines: heading slugs (GitHub suffixes repeats -1, -2, …) and `<a id|name>`. */
export function anchors(text) {
  const ids = new Set();
  const seen = new Map();
  for (const line of unfenced(text)) {
    const h = line.match(/^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/);
    if (h) {
      const s = slug(h[1]);
      const n = seen.get(s) ?? 0;
      seen.set(s, n + 1);
      ids.add(n ? `${s}-${n}` : s);
    }
    for (const m of line.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) ids.add(m[1]);
  }
  return ids;
}

/** `#x` and `other.md#x` links against that doc's anchors. `#L9` names a line, not a heading. */
export function checkAnchors(rel, text, read, exists, report) {
  const own = anchors(text);
  unfenced(text).forEach((l, i) => {
    for (const m of l.matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
      const [, target, frag] = m;
      if ((target && !target.endsWith(".md")) || /^L\d+(-L\d+)?$/.test(frag)) continue;
      const path = join(dirname(rel), target);
      if (target && !exists(path)) continue;
      if (!(target ? anchors(read(path)) : own).has(frag))
        report(i + 1, `broken anchor \`${target}#${frag}\``);
    }
  });
}

/** Whether git ignores `p`. A directory-only pattern (`dist/`) matches the slash form when the directory isn't built (SW-159). */
export function isIgnored(p, cwd) {
  return [p, `${p}/`].some((q) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", q], { cwd });
      return true;
    } catch {
      return false;
    }
  });
}

/** The built CLI's commands and their long flags, hidden ones included. */
function loadCli() {
  return {
    commands: new Map(
      cliReference().map((c) => [c.name, new Set(c.options.flatMap((o) => o.long ?? []))]),
    ),
  };
}

/** Tool names as the MCP server registers them, plus the plugin's own (`$.tool.register`). */
function loadTools() {
  const tools = new Set(mcpTools(mcpSource()).map((t) => t.name));
  const plugin = readFileSync(join(ROOT, "plugins/werkmeister/hooks/register.tsx"), "utf8");
  for (const m of plugin.matchAll(/const \w+_TOOL = "([^"]+)"/g)) tools.add(m[1]);
  return tools;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Judged against tracked files, not the disk, so a build product present on
  // this machine (the generated Caddyfile) can't pass here and fail in CI. A
  // gitignored path is generated, so it can't be checked and is accepted.
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const files = new Set(tracked);
  const dirs = new Set(
    tracked.flatMap((f) =>
      f
        .split("/")
        .slice(0, -1)
        .map((_, i, a) => a.slice(0, i + 1).join("/")),
    ),
  );
  const docs = tracked.filter((f) => f.endsWith(".md") && !SKIP.some((re) => re.test(f)));
  const ctx = {
    cli: loadCli(),
    tools: loadTools(),
    regions: await loadRegions(),
    exists: (p) => {
      const rel = normalize(p).replace(/\/$/, "");
      return files.has(rel) || dirs.has(rel) || isIgnored(rel, ROOT);
    },
    read: (p) => readFileSync(join(ROOT, p), "utf8"),
  };
  const pages = manPages(cliReference().filter((c) => !c.hidden));
  const problems = [
    ...docs.flatMap((rel) => checkDoc(rel, readFileSync(join(ROOT, rel), "utf8"), ctx)),
    ...checkMan(pages, MAN_DIR),
    ...(withMan(readFileSync(CLI_PACKAGE, "utf8"), pages) === readFileSync(CLI_PACKAGE, "utf8")
      ? []
      : ["apps/cli/package.json: `man` doesn't list the man pages, run `pnpm run docs:gen`"]),
  ];
  for (const p of problems) console.error(p);
  console.log(`${docs.length} docs checked, ${problems.length} problem(s).`);
  process.exit(problems.length ? 1 : 0);
}
