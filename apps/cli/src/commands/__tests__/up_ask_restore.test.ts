/**
 * SW-835: a workspace whose `.claude/settings.json` lost its ask block (a hand
 * `jq 'del(.permissions.ask)'`) gets it back from `claude-permissions.json` on
 * the next `feature up --service`, the start every run makes.
 *
 * A subprocess of the built CLI, like `up_exit.test.ts`, so the whole path runs:
 * up.ts → refreshWorkspaceSettings → the strategy's refresh → the permissions merge.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { FIXTURE_FEATURE, seedFixture } from "werkmeister-core/fixture_workspace";

const MAIN = path.join(path.resolve(fileURLToPath(import.meta.url), "../../../.."), "dist/main.js");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function cli(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; out: string }> {
  // A non-TTY stdin makes `workspace init` read fd 0 and hang (SW-323).
  const child = spawn(process.execPath, [MAIN, ...argv], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, out })));
}

it("feature up --service restores an ask block deleted after init", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "up-ask-")));
  roots.push(root);
  const fx = seedFixture(root);
  const env: NodeJS.ProcessEnv = { ...process.env, ...fx.env };
  const settingsFile = path.join(fx.workspace, ".claude", "settings.json");
  const read = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  const init = await cli(["workspace", "init"], fx.workspace, env);
  expect(init.status, init.out).toBe(0);
  const written = read();
  expect(written.permissions.ask.length).toBeGreaterThan(0);

  const deleted = read();
  delete deleted.permissions.ask;
  fs.writeFileSync(settingsFile, `${JSON.stringify(deleted, null, 2)}\n`);

  const up = await cli(["feature", "up", "--service", "lib"], fx.workspace, env);
  expect(up.status, up.out).toBe(0);
  expect(up.out).toContain(`Started ${FIXTURE_FEATURE}-lib`);
  expect(read()).toEqual(written);
});
