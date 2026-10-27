/**
 * `werkmeister pr new` argument wiring through the built CLI (SW-103); werkmeister-core's
 * pr-lifecycle tests cover what it does.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const CLI_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../..");
/** Built by the `test` script. */
const MAIN = path.join(CLI_DIR, "dist/main.js");

let ws: string;
beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-new-"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "feature: f\n");
});
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

it.each([[["new", "app"]], [["new", "--slug", "fix"]]])(
  "pr %j without a worktree and a slug prints the usage",
  (argv) => {
    const res = spawnSync(process.execPath, [MAIN, "pr", ...argv], {
      cwd: ws,
      env: { ...process.env, HOME: path.join(ws, "home") },
      encoding: "utf-8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("Usage: werkmeister pr new <worktree> --slug <slug>");
  },
);
