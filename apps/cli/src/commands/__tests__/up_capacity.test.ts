/**
 * SW-685: a capacity wait through the built CLI. The fixture's fake docker shows a 6-CPU holder on a
 * 6-CPU budget, so `feature up` (demo costs 1 CPU) queues and exits 75, and `budget status` reads the
 * queue it left.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FIXTURE_FEATURE, seedFixture } from "werkmeister-core/fixture_workspace";

const MAIN = path.join(path.resolve(fileURLToPath(import.meta.url), "../../../.."), "dist/main.js");

let root: string;
let fx: ReturnType<typeof seedFixture>;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "up-capacity-")));
  fx = seedFixture(root, {
    config: { budget: { cpus: 6 } },
    containers: [
      {
        feature: "holder",
        workspace: "holder",
        startedAt: "2026-11-13T00:00:00Z",
        memory: 0,
        nanoCpus: 6e9,
      },
    ],
  });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function cli(...argv: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [MAIN, ...argv], {
      cwd: fx.workspace,
      env: { ...process.env, ...fx.env },
      encoding: "utf-8",
      timeout: 120_000,
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

it("feature up waits behind the holder with exit 75, and budget status shows both", async () => {
  const init = await cli("workspace", "init", "--no-build");
  expect(init.code, init.out).toBe(0);

  const up = await cli("feature", "up", FIXTURE_FEATURE);
  expect(up.out).toContain("running: holder (6 CPUs, 0.0 GiB, a person's workspace)");
  expect(up.code, up.out).toBe(75);

  const status = await cli("budget", "status");
  expect(status.code, status.out).toBe(0);
  expect(status.out).toMatch(/Running:\n {2}holder \(6 CPUs/);
  expect(status.out).toMatch(/Waiting:\n {2}1\. demo {2}whole feature \(1 CPUs/);
});
