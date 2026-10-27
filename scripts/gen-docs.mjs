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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
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

/** Every region's Markdown, keyed by name. */
export async function loadRegions() {
  const hooks = await import(
    pathToFileURL(join(ROOT, "packages/werkmeister-core/dist/hooks_gen.js")).href
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
    "cli-reference": commands
      .map((c) =>
        [
          kept(`- \`werkmeister ${c.name}${c.usage ? ` ${c.usage}` : ""}\`: ${md(c.description)}`),
          ...c.options
            .filter((o) => !o.hidden)
            .map((o) => kept(`  - \`${o.flags}\`: ${md(o.description)}`)),
        ].join("\n"),
      )
      .join("\n"),
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
  process.exit(failed ? 1 : 0);
}
