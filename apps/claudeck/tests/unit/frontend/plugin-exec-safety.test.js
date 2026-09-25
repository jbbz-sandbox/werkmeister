// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const PLUGIN_CLIENTS = [
  "plugins/sandbox-workspace/client.js",
  "plugins/repos/client.js",
];

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

describe("bundled plugins", () => {
  it.each(PLUGIN_CLIENTS)("%s builds no shell command from data", (rel) => {
    const source = readFileSync(join(root, rel), "utf-8");
    expect(offendingShellCalls(source)).toEqual([]);
  });

  it("catches every shape a shell command can be built from data", () => {
    const samples = [
      "await execCommand(`git checkout ${branch}`, dir);",
      "const cmd = `git add ${args}`;\nawait execCommand(cmd, dir);",
      'await execCommand("git checkout " + branch, dir);',
      "await execCommand(\n  `git diff ${file}`,\n  dir,\n);",
    ];
    for (const sample of samples) {
      expect(offendingShellCalls(sample)).not.toEqual([]);
    }
  });

  it("accepts a literal constant", () => {
    expect(offendingShellCalls('await execCommand("code .", project);')).toEqual([]);
  });
});
