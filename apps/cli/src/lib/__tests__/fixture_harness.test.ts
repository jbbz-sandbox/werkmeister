/**
 * SW-292: one generated command seeds a fixture, runs this build's CLI against it and cleans up;
 * nothing under it reaches the caller's HOME, Docker engine, gh or docker.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";
import { writeFixtureWrapper } from "werkmeister-core/fixture_workspace";
import { writeTempHomeWrapper } from "werkmeister-core/temp_home";

const REPO = path.resolve(import.meta.dirname, "../../../../..");

let tmp: string;
let engineHits = 0;
const engine = http.createServer((_req, res) => {
  engineHits++;
  res.writeHead(500).end();
});

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fixture-harness-")));
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
});
afterAll(() => {
  engine.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("runs init and the gate in a fixture, prints the context and fake calls, and touches nothing real", async () => {
  // A workspace whose one worktree is this checkout, so the wrapper finds this build's CLI.
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  fs.symlinkSync(REPO, path.join(ws, "werkmeister"));
  writeTempHomeWrapper(ws);
  const wrapper = writeFixtureWrapper(ws);
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  const scratch = path.join(tmp, "tmp");
  fs.mkdirSync(scratch);
  const { port } = engine.address() as { port: number };
  // The caller's own claude and kubectl, first on PATH, must never run (SW-424).
  const callerBin = path.join(tmp, "caller-bin");
  const hits = path.join(tmp, "caller-hits");
  fs.mkdirSync(callerBin);
  for (const name of ["claude", "kubectl"])
    fs.writeFileSync(path.join(callerBin, name), `#!/bin/sh\necho ${name} >> '${hits}'\n`, {
      mode: 0o755,
    });

  const run = await promisify(execFile)(
    wrapper,
    [
      "--no-wait",
      "--gate",
      "--print",
      ".werkmeister/werkmeister-context.md",
      "workspace",
      "init",
      "--no-build",
      "--then",
      "pr",
      // No --no-wait here: the leading one reaches the gate's load wait (SW-425).
      "gate",
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: scratch,
        DOCKER_HOST: `tcp://127.0.0.1:${port}`,
        WERKMEISTER_ROOT: "/elsewhere/apps/cli",
        PATH: `${callerBin}:${process.env.PATH}`,
        ANTHROPIC_API_KEY: "caller-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "caller-secret",
        KUBECONFIG: path.join(tmp, "caller-kubeconfig"),
        GH_TOKEN: "caller-secret",
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  expect(run.stdout).toMatch(/app: gate passed/);
  expect(run.stdout).toMatch(/--- \.werkmeister\/werkmeister-context\.md\n[\s\S]*`lib`/);
  expect(run.stdout).toMatch(/--- docker calls\n[\s\S]*^exec demo-lib sh -c .* sh -c true$/m);
  expect(fs.readdirSync(home)).toEqual([]);
  expect(engineHits).toBe(0);
  expect(fs.existsSync(hits), "the caller's claude or kubectl ran").toBe(false);
  expect(fs.readdirSync(scratch), "the fixture and temp HOME are removed").toEqual([]);
}, 120_000);
