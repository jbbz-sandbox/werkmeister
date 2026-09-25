// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// A shell command must be a literal constant. Anything else — a template
// literal, a variable, a concatenation — could carry repository data, which
// is the bug this branch exists to remove. An unavoidable exception carries
// an explicit `shell-safe:` annotation on the line above, saying why.
const SHELL_CALL = /exec(?:Command|Shell)\(([^)]*)\)/g;
const STRING_LITERAL = /^\s*(['"])(?:(?!\1)[^\\]|\\.)*\1\s*$/;

function offendingShellCalls(source) {
  const offenders = [];
  for (const match of source.matchAll(SHELL_CALL)) {
    const firstArg = match[1].split(",")[0];
    if (STRING_LITERAL.test(firstArg)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    const previous = source.split("\n")[line - 2] ?? "";
    if (previous.includes("shell-safe:")) continue;
    offenders.push([line, firstArg.trim()]);
  }
  return offenders;
}

// Same rule, different shape: a raw fetch("/api/exec", ...) that builds its
// own request body bypasses execShell entirely, so the `shellCommand:`
// property of the object literal needs the identical check — literal string,
// or an explicit `shell-safe:` annotation on the line above.
const SHELL_COMMAND_PROP = /shellCommand\s*:\s*([^,}]+)/g;

function offendingShellCommandProps(source) {
  const offenders = [];
  for (const match of source.matchAll(SHELL_COMMAND_PROP)) {
    const value = match[1];
    if (STRING_LITERAL.test(value)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    const previous = source.split("\n")[line - 2] ?? "";
    if (previous.includes("shell-safe:")) continue;
    offenders.push([line, value.trim()]);
  }
  return offenders;
}

function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// Glob plugins/*/client.js instead of hardcoding names, so a new plugin is
// covered the day it lands rather than the day someone remembers to list it.
const pluginsDir = join(root, "plugins");
const PLUGIN_CLIENTS = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `plugins/${entry.name}/client.js`)
  .filter((rel) => existsSync(join(root, rel)));

const PUBLIC_JS_FILES = walkJsFiles(join(root, "public/js")).map((f) => relative(root, f));

describe("bundled plugins", () => {
  it("found at least one plugin client to check — a bad glob must fail loudly", () => {
    expect(PLUGIN_CLIENTS.length).toBeGreaterThan(0);
  });

  it.each(PLUGIN_CLIENTS)("%s builds no shell command from data", (rel) => {
    const source = readFileSync(join(root, rel), "utf-8");
    expect(offendingShellCalls(source)).toEqual([]);
  });

  it("catches every shape a shell command can be built from data", () => {
    const samples = [
      "await execShell(`git checkout ${branch}`, dir);",
      "const cmd = `git add ${args}`;\nawait execShell(cmd, dir);",
      'await execShell("git checkout " + branch, dir);',
      "await execShell(\n  `git diff ${file}`,\n  dir,\n);",
    ];
    for (const sample of samples) {
      expect(offendingShellCalls(sample)).not.toEqual([]);
    }
  });

  it("accepts a literal constant", () => {
    expect(offendingShellCalls('await execShell("code .", project);')).toEqual([]);
  });
});

describe("public/js raw-fetch shellCommand bodies", () => {
  it("found files to check — a bad glob must fail loudly", () => {
    expect(PUBLIC_JS_FILES.length).toBeGreaterThan(0);
  });

  it("builds no shellCommand body from data anywhere under public/js", () => {
    const offenders = PUBLIC_JS_FILES.flatMap((rel) => {
      const source = readFileSync(join(root, rel), "utf-8");
      return offendingShellCommandProps(source).map(([line, value]) => `${rel}:${line} ${value}`);
    });
    expect(offenders).toEqual([]);
  });

  it("flags a shellCommand body built from a template literal", () => {
    expect(
      offendingShellCommandProps("body: JSON.stringify({ shellCommand: `code ${dir}`, cwd }),"),
    ).not.toEqual([]);
  });
});
