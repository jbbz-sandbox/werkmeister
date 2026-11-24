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

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeFixtureWrapper, writeTempHomeWrapper } from "werkmeister-core/temp_home";

const REPO = path.resolve(import.meta.dirname, "../../../../..");

let tmp: string;
let engineHits = 0;
const engine = http.createServer((_req, res) => {
  engineHits++;
  res.writeHead(500).end();
});
// The caller's daemon, exported in its shell: the fixture must leave it dead (SW-426).
let daemonHits = 0;
const callerDaemon = http.createServer((_req, res) => {
  daemonHits++;
  res.writeHead(500).end();
});

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fixture-harness-")));
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => callerDaemon.listen(0, "127.0.0.1", resolve));
});
afterAll(() => {
  engine.close();
  callerDaemon.close();
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
      // No --no-wait here: the gate itself never waits on load (SW-542).
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
        WERKMEISTER_HOST: `http://127.0.0.1:${(callerDaemon.address() as { port: number }).port}`,
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
  expect(run.stdout).toMatch(/--- docker calls\n[\s\S]*^exec demo-lib true$/m);
  expect(fs.readdirSync(home)).toEqual([]);
  expect(engineHits).toBe(0);
  expect(daemonHits).toBe(0);
  // Every gh call went to the fake, which logs it; a reload would show as a docker call to w9r-caddy.
  expect(run.stdout).toMatch(/--- gh calls\n/);
  expect(run.stdout.slice(run.stdout.indexOf("--- docker calls"))).not.toMatch(/caddy/i);
  expect(fs.existsSync(hits), "the caller's claude or kubectl ran").toBe(false);
  expect(fs.readdirSync(scratch), "the fixture and temp HOME are removed").toEqual([]);
}, 120_000);

// SW-916: the wrapper's allow rule doesn't pin the cwd, so a file flag must resolve against the
// built CLI's own worktree; from another folder a relative path there must not read that folder.
it("file flags resolve against the CLI's worktree, never the shell's cwd (SW-916)", async () => {
  const ws = path.join(tmp, "ws916");
  fs.mkdirSync(ws);
  fs.symlinkSync(REPO, path.join(ws, "werkmeister"));
  writeTempHomeWrapper(ws);
  const wrapper = writeFixtureWrapper(ws);
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "caller-secret\n");
  const leak = (file: string) =>
    promisify(execFile)(
      wrapper,
      ["--no-wait", "--gate", "--change", "leak.txt", "--change-branch", file].concat([
        "--print",
        "app/leak.txt",
        "--version",
      ]),
      { cwd: outside, env: { ...process.env, HOME: outside } },
    ).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({
        code: e.code,
        out: e.stdout + e.stderr,
      }),
    );
  const refused = await leak("secret.txt");
  expect(refused.out).not.toMatch(/caller-secret/);
  expect(refused.code).toBe(2);
  expect(refused.out).toMatch(/--change-branch: a file under/);
  const own = await leak("apps/cli/package.json");
  expect(own.code, own.out).toBe(0);
  expect(own.out).toMatch(/--- app\/leak\.txt\n\{[\s\S]*"name": "werkmeister"/);
}, 120_000);

// SW-1108: one harness call builds an icm workspace from a workflow folder, and an edit to it
// between steps shows as drift, with no hand-made probe.
describe("--workflow and --then-append", () => {
  const WORKFLOW = "apps/cli/src/lib/__tests__/fixtures/workflows/review";
  let wrapper: string;
  let home: string;
  let scratch: string;
  beforeAll(() => {
    const ws = path.join(tmp, "ws1108");
    fs.mkdirSync(ws);
    fs.symlinkSync(REPO, path.join(ws, "werkmeister"));
    writeTempHomeWrapper(ws);
    wrapper = writeFixtureWrapper(ws);
    home = path.join(tmp, "home1108");
    fs.mkdirSync(home);
    scratch = path.join(tmp, "tmp1108");
    fs.mkdirSync(scratch);
  });
  const harness = (args: string[]) =>
    promisify(execFile)(wrapper, ["--no-wait", ...args], {
      env: { ...process.env, HOME: home, TMPDIR: scratch },
      maxBuffer: 16 * 1024 * 1024,
    }).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({
        code: e.code,
        out: e.stdout + e.stderr,
      }),
    );
  // The folder init names, from this run's fixture root (`<tmp>/werkmeister-fixture-*`) down.
  const seededAt = (out: string) =>
    /workflow from \S*?(werkmeister-fixture-[^/\s]+\/\S*?workflows\/review)/.exec(out)?.[1];

  it("seeds the folder under the fixture's temp HOME, inits from it and skills check is fresh", async () => {
    const r = await harness([
      "--workflow",
      WORKFLOW,
      "workspace",
      "init",
      "--no-build",
      "--then",
      "skills",
      "check",
    ]);
    expect(r.code, r.out).toBe(0);
    // <fixture root>/home is the steps' HOME (seedFixture), so this is the temp HOME's own folder.
    expect(seededAt(r.out)).toMatch(
      /^werkmeister-fixture-[^/]+\/home\/\.werkmeister\/workflows\/review$/,
    );
    expect(r.out).toMatch(/Context layer fresh \(icm\)/);
    expect(fs.readdirSync(home), "the caller's HOME is untouched").toEqual([]);
    expect(fs.readdirSync(scratch), "the fixture and temp HOME are removed").toEqual([]);
  }, 120_000);

  it("--workflow-in repo seeds it in the fixture's code repo", async () => {
    const r = await harness([
      "--workflow",
      WORKFLOW,
      "--workflow-in",
      "repo",
      "workspace",
      "init",
      "--no-build",
      "--then",
      "skills",
      "check",
    ]);
    expect(r.code, r.out).toBe(0);
    expect(seededAt(r.out)).toMatch(
      /^werkmeister-fixture-[^/]+\/ws\/demo\/app\/\.werkmeister\/workflows\/review$/,
    );
  }, 120_000);

  it("--then-append to a stage template after init makes skills check name the template", async () => {
    const r = await harness([
      "--workflow",
      WORKFLOW,
      "workspace",
      "init",
      "--no-build",
      "--then-append",
      "workflow:stages/triage.md",
      "An edit after init.",
      "--then",
      "skills",
      "check",
    ]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(
      /template changed since init: \S+\/home\/\.werkmeister\/workflows\/review/,
    );
  }, 120_000);

  // SW-1126: the fixture seeds the shared workspace repo, so a record-repo read runs.
  it("metrics rebuild after an abandon reads the fixture's record origin", async () => {
    const r = await harness([
      "--postmortem",
      "--workspace-repo",
      "workspace",
      "init",
      "--no-build",
      "--then",
      "workspace",
      "abandon",
      "fixture probe",
      "demo",
      "--yes",
      "--then",
      "metrics",
      "rebuild",
    ]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/no workspace repo/);
    expect(r.out).toMatch(/metrics rebuild: \d+ added/);
  }, 120_000);
});
