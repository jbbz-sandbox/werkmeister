#!/usr/bin/env node
/**
 * SW-81: rewrite every `<!-- generated:<name> -->` … `<!-- /generated -->`
 * region in the tracked Markdown from the source it restates. `docs:check`
 * fails when a region differs from what this would write, so a hand-edit or a
 * source change without a rerun is caught. See docs/docs-sync.md.
 *
 * Reads the built core and CLI, so run after `pnpm run build`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const OPEN = /<!-- generated:([\w-]+) -->/g;
// A body never spans another opener, so an unclosed region can't swallow the next one.
export const REGION =
  /<!-- generated:([\w-]+) -->(?:(?!<!-- generated:)[\s\S])*?<!-- \/generated -->/g;

/**
 * `text` with each region's body replaced by `regions[name]`. Blank lines around
 * the body keep a table or list next to a marker from parsing as part of it.
 */
export function fill(text, regions) {
  const problems = [];
  const line = (index) => text.slice(0, index).split("\n").length;
  const closed = new Set([...text.matchAll(REGION)].map((m) => m.index));
  for (const m of text.matchAll(OPEN))
    if (!closed.has(m.index))
      problems.push({
        line: line(m.index),
        msg: `generated region \`${m[1]}\` has no \`<!-- /generated -->\``,
      });
  const out = text.replace(REGION, (whole, name, index) => {
    if (!(name in regions)) {
      problems.push({ line: line(index), msg: `unknown generated region \`${name}\`` });
      return whole;
    }
    return `<!-- generated:${name} -->\n\n${regions[name]}\n\n<!-- /generated -->`;
  });
  return { text: out, problems };
}

/** Escape what Markdown would eat outside code spans: a `<placeholder>`, and `|` in a table cell. */
function md(s, cell = false) {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .split(/(`[^`]*`)/)
    .map((part, i) => {
      if (i % 2) return part;
      const escaped = part.replace(/</g, "\\<");
      return cell ? escaped.replace(/\|/g, "\\|") : escaped;
    })
    .join("");
}

/** The MCP server's tools in registration order: name, title, and whether only the App UI sees it. */
export function mcpTools(src) {
  return src
    .split(/(?=\bregister(?:App)?Tool\()/)
    .slice(1)
    .flatMap((call) => {
      const m = call.match(
        /^register(?:App)?Tool\(\s*(?:server,\s*)?"([^"]+)",\s*\{\s*title:\s*"([^"]+)"/,
      );
      return m
        ? [{ name: m[1], title: m[2], app: /APP_ONLY|visibility:\s*\["app"\]/.test(call) }]
        : [];
    });
}

export function mcpSource() {
  const dir = join(ROOT, "apps/werkmeister-mcp/src");
  // Top-level files first, then src/harness/claude/ (SW-187), so the tool table keeps its order.
  const depth = (f) => f.split(sep).length;
  return readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".ts"))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

/** The built CLI's commander model, from its `__reference` mode. */
export function cliReference() {
  const main = join(ROOT, "apps/cli/dist/main.js");
  if (!existsSync(main))
    throw new Error("apps/cli/dist/main.js is missing — run `pnpm run build` first");
  return JSON.parse(execFileSync(process.execPath, [main, "__reference"], { encoding: "utf8" }));
}

// Each CLI rule is written for every launcher name; the doc lists the `werkmeister` one.
const rules = (list) =>
  list
    .filter((r) => !/^Bash\(w9r /.test(r))
    .map((r) => `\`${r}\``)
    .join(", ");

// `migrate` names the old paths on purpose (its source line carries the same marker).
const kept = (line) => (/sandbox/i.test(line) ? `${line} <!-- name-check: ignore -->` : line);

/** Commands in their `--help` groups, in order: [heading without its colon, commands]. */
export function byGroup(commands) {
  const groups = new Map();
  for (const c of commands) {
    const heading = c.group.replace(/:$/, "");
    groups.set(heading, [...(groups.get(heading) ?? []), c]);
  }
  return [...groups];
}

/**
 * A help.md body for the guide: its `## Description` heading goes (the command's
 * heading already says what it is), other sections become bold labels so they
 * don't nest below the guide's own headings.
 */
export function guideBody(help) {
  return help
    .replace(/^## Description\n+/m, "")
    .replace(/^## (.+)$/gm, "**$1**")
    .trim();
}

/** The users guide's command reference: each group, then each command's usage, flags and help.md. */
export function cliGuide(commands) {
  return byGroup(commands)
    .map(([heading, cmds]) =>
      [
        `### ${heading}`,
        ...cmds.map((c) =>
          [
            `#### werkmeister ${c.name}`,
            kept(md(c.description)),
            kept(`\`werkmeister ${c.name}${c.usage ? ` ${c.usage}` : ""}\``),
            c.options
              .filter((o) => !o.hidden)
              .map((o) => kept(`- \`${o.flags}\`: ${md(o.description)}`))
              .join("\n"),
            guideBody(c.help),
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      ].join("\n\n"),
    )
    .join("\n\n");
}

/** Escape text for roff: backslashes, hyphens (else they render as a typographic dash), inline Markdown. */
function roffText(s) {
  return s
    .replace(/\\/g, "\\e")
    .replace(/-/g, "\\-")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*|`([^`]+)`/g, (_, b, c) => `\\fB${b ?? c}\\fR`)
    .replace(/^[.']/, "\\&$&");
}

/**
 * The Markdown subset help.md uses, as man(7) roff: `##` sections, paragraphs,
 * `-`/`1.` lists, fenced blocks and tables (both kept verbatim), inline bold,
 * code and links. ponytail: hand-written, not a converter dependency; extend it
 * when a help.md needs more.
 */
export function roff(markdown) {
  const out = [];
  let verbatim = false;
  let para = [];
  const flush = () => {
    if (para.length) out.push(roffText(para.join(" ")));
    para = [];
  };
  for (const line of markdown.trim().split("\n")) {
    if (/^\s*```/.test(line)) {
      flush();
      verbatim = !verbatim;
      out.push(verbatim ? ".PP\n.nf\n.RS 4" : ".RE\n.fi");
    } else if (verbatim) {
      out.push(roffText(line).replace(/\\fB|\\fR/g, ""));
    } else if (line.startsWith("|")) {
      flush();
      if (!/^\|[\s|:-]+\|$/.test(line)) out.push(`.nf\n${roffText(line)}\n.fi`);
    } else if (/^## /.test(line)) {
      flush();
      out.push(`.SH ${roffText(line.slice(3).toUpperCase())}`);
    } else if (/^\s*(- |\d+\. )/.test(line)) {
      flush();
      const [, indent, mark, rest] = line.match(/^(\s*)(- |\d+\. )(.*)/);
      const tag = mark === "- " ? "\\(bu" : mark.trim();
      out.push(`.IP ${tag} ${indent ? 6 : 3}`);
      para.push(rest);
    } else if (!line.trim()) {
      flush();
      out.push(".PP");
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out
    .join("\n")
    .replace(/(\.PP\n)+(?=\.(SH|PP|IP))/g, "")
    .replace(/\.PP\n(\.PP\n)+/g, ".PP\n");
}

const TH = (name) => `.TH ${name.toUpperCase()} 1 "" "werkmeister" "Werkmeister Manual"`;

/**
 * `apps/cli/man/*.1`, keyed by file name: `werkmeister.1` lists the commands by
 * group, and `werkmeister-<command>.1` (git's convention, so `man werkmeister-up`
 * works) holds its synopsis, options and help.md. No version or date in `.TH`:
 * either would make every release PR fail docs:check.
 */
// One page per command; `feature up` (SW-186) is `werkmeister-feature-up(1)`, as git names `git-remote`.
const page = (c) => c.name.replaceAll(" ", "-");

export function manPages(commands) {
  const pages = {
    "werkmeister.1": [
      TH("werkmeister"),
      ".SH NAME",
      "werkmeister \\- multi\\-feature concurrent development orchestrator",
      ".SH SYNOPSIS",
      "\\fBwerkmeister\\fR \\fIcommand\\fR [\\fIoptions\\fR]",
      ".SH DESCRIPTION",
      "Runs many features at once, each in its own slot, with only the services it changes running locally. \\fBwerkmeister\\fR \\fIcommand\\fR \\fB\\-\\-help\\fR and \\fBwerkmeister\\-\\fR\\fIcommand\\fR(1) describe each command.",
      ".SH COMMANDS",
      ...byGroup(commands).flatMap(([heading, cmds]) => [
        `.SS ${roffText(heading)}`,
        ...cmds.flatMap((c) => [
          ".TP",
          `\\fB${roffText(c.name)}\\fR ${roffText(c.usage)}`.trim(),
          roffText(md(c.description)),
        ]),
      ]),
      ".SH SEE ALSO",
      commands.map((c) => `\\fBwerkmeister\\-${roffText(page(c))}\\fR(1)`).join(",\n"),
    ].join("\n"),
  };
  for (const c of commands) {
    const options = c.options.filter((o) => !o.hidden);
    pages[`werkmeister-${page(c)}.1`] = [
      TH(`werkmeister-${page(c)}`),
      ".SH NAME",
      `werkmeister\\-${roffText(page(c))} \\- ${roffText(md(c.description))}`,
      ".SH SYNOPSIS",
      `\\fBwerkmeister ${roffText(c.name)}\\fR ${roffText(c.usage)}`.trim(),
      ...(options.length
        ? [
            ".SH OPTIONS",
            ...options.flatMap((o) => [
              ".TP",
              `\\fB${roffText(o.flags)}\\fR`,
              roffText(md(o.description)),
            ]),
          ]
        : []),
      roff(c.help),
      ".SH SEE ALSO",
      "\\fBwerkmeister\\fR(1)",
    ].join("\n");
  }
  // A roff comment carries `kept`'s marker without showing on the page.
  const keptRoff = (text) =>
    text
      .split("\n")
      .map((l) => (/sandbox/i.test(l) ? `${l} \\" name-check: ignore` : l))
      .join("\n");
  return Object.fromEntries(Object.entries(pages).map(([f, text]) => [f, `${keptRoff(text)}\n`]));
}

export const MAN_DIR = join(ROOT, "apps/cli/man");
export const CLI_PACKAGE = join(ROOT, "apps/cli/package.json");

/** The CLI's package.json with its `man` array listing `pages`, which npm links on a global install. */
export function withMan(packageJson, pages) {
  const pkg = JSON.parse(packageJson);
  pkg.man = Object.keys(pages).map((f) => `./man/${f}`);
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Every region's Markdown, keyed by name. */
export async function loadRegions() {
  const hooks = await import(
    pathToFileURL(join(ROOT, "packages/werkmeister-core/dist/harness/claude/hooks_gen.js")).href
  );
  const tools = mcpTools(mcpSource());
  const commands = cliReference().filter((c) => !c.hidden);
  const workspaces = ["apps", "packages"].map((dir) => {
    const rows = readdirSync(join(ROOT, dir))
      .filter((d) => existsSync(join(ROOT, dir, d, "package.json")))
      .map((d) => {
        const { name, description } = JSON.parse(
          readFileSync(join(ROOT, dir, d, "package.json"), "utf8"),
        );
        return `| \`${name}\` | [${dir}/${d}](${dir}/${d}) | ${md(description ?? "", true)} |`;
      });
    const kind = dir === "apps" ? "App" : "Package";
    return [`| ${kind} | Path | What |`, "| --- | --- | --- |", ...rows].join("\n");
  });
  return {
    "autonomous-allow": rules(hooks.autonomousRules("<feature>", ["<svc>"])),
    "autonomous-deny": rules(hooks.AUTONOMOUS_DENY),
    "mcp-tools": [
      `${tools.length} tools (${tools.filter((t) => t.app).length} UI-only).`,
      "",
      "| Tool | What it does |",
      "| --- | --- |",
      ...tools.map((t) => `| \`${t.name}\` | ${md(t.title, true)}${t.app ? " (UI-only)" : ""} |`),
    ].join("\n"),
    "cli-reference": cliGuide(commands),
    workspaces: workspaces.join("\n\n"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const regions = await loadRegions();
  const docs = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  let failed = false;
  for (const rel of docs) {
    const before = readFileSync(join(ROOT, rel), "utf8");
    if (!before.includes("<!-- generated:")) continue;
    const { text, problems } = fill(before, regions);
    for (const p of problems) console.error(`${rel}:${p.line}: ${p.msg}`);
    failed ||= problems.length > 0;
    if (text !== before) {
      writeFileSync(join(ROOT, rel), text);
      console.log(`rewrote ${rel}`);
    }
  }
  const pages = manPages(cliReference().filter((c) => !c.hidden));
  mkdirSync(MAN_DIR, { recursive: true });
  for (const f of readdirSync(MAN_DIR))
    if (!(f in pages)) {
      rmSync(join(MAN_DIR, f));
      console.log(`removed apps/cli/man/${f}`);
    }
  for (const [f, text] of Object.entries(pages)) {
    const file = join(MAN_DIR, f);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    writeFileSync(file, text);
    console.log(`rewrote apps/cli/man/${f}`);
  }
  const pkg = readFileSync(CLI_PACKAGE, "utf8");
  if (withMan(pkg, pages) !== pkg) {
    writeFileSync(CLI_PACKAGE, withMan(pkg, pages));
    console.log("rewrote apps/cli/package.json");
  }
  process.exit(failed ? 1 : 0);
}
