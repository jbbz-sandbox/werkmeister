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

// A shell command assembled from data is the bug this plan exists to remove:
// double quotes do not stop $(...) or backticks, and a repository can be a
// clone of someone else's code. Commands built from data must go through
// execArgv, which passes an argument array to execFile with no shell.
const INTERPOLATED_SHELL_CALL = /exec(?:Command|Shell)\(\s*`[^`]*\$\{/;

describe("bundled plugins", () => {
  it.each(PLUGIN_CLIENTS)("%s builds no shell command from data", (rel) => {
    const source = readFileSync(join(root, rel), "utf-8");
    const offenders = source
      .split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => INTERPOLATED_SHELL_CALL.test(line));

    expect(offenders).toEqual([]);
  });

  it("detects an interpolated shell call when one exists", () => {
    // Guards the guard: a regex that matches nothing would pass the test above
    // for the wrong reason.
    const sample = 'await execCommand(`git checkout ${branch}`, dir);';
    expect(INTERPOLATED_SHELL_CALL.test(sample)).toBe(true);
  });
});
