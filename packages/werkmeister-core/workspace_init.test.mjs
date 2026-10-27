// `workspace.ts` and `init_workspace.ts` ended their fatal paths on
// `error(msg); process.exit(1)`. A library cannot exit, so those became
// `fail()`: emit the same `[err]` line, then throw. Two things have to hold or
// the CLI's output changes — the line still goes out exactly once, and the
// throw is the silent kind the argv adapters turn into exit 1 without
// reprinting (note 086 row 5).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { dotDir } from "./dist/config.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { createWorkspace } from "./dist/sandbox.js";
import { provisionWorkspace, WorkspaceInitError } from "./dist/workspace_init.js";
import { dockerAvailable, withSandboxHome } from "./fixtures.mjs";

/** Run `fn`, returning its rejection and everything it printed. */
async function abort(fn) {
  const collector = collectingReporter();
  const err = await withReporter(collector, () =>
    fn().then(
      () => null,
      (e) => e,
    ),
  );
  return { err, text: collector.text() };
}

test("a missing feature aborts before touching the filesystem", async () => {
  const { err, text } = await abort(() => provisionWorkspace({}));
  assert.ok(err instanceof WorkspaceInitError, `got ${err}`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserts the raw ANSI colour code
  assert.match(text, /^\x1b\[31m\[err\] {2}A feature name is required/);
  // Exactly one line: the adapters exit on this without printing it again.
  assert.equal(text.trimEnd().split("\n").length, 1);
  assert.match(err.message, /^A feature name is required/);
});

test("a feature that is not a slug aborts with the name it rejected", async () => {
  const { err, text } = await abort(() => provisionWorkspace({ feature: "Not A Slug" }));
  assert.ok(err instanceof WorkspaceInitError, `got ${err}`);
  assert.match(text, /Workspace name 'not a slug' is not a valid slug/);
  assert.equal(text.trimEnd().split("\n").length, 1);
});

test("an unknown context_strategy aborts before the workspace dir is created", async () => {
  const { err, text } = await abort(() =>
    provisionWorkspace({ feature: "demo", context_strategy: "bogus" }),
  );
  assert.equal(err.code, "UNKNOWN_CONTEXT_STRATEGY");
  assert.match(err.message, /'bogus'.*icm, jit/);
  // Rejected before touching the filesystem — nothing to print.
  assert.equal(text, "");
});

test("a non-interactive create with no strategy writes context_strategy: icm (#190)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "create-default-"));
  const repos = path.join(tmp, "repos");
  // demo-repo needs an origin: worktrees branch from origin's default branch.
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  execFileSync("git", ["-C", seed, "init", "-q", "-b", "main"]);
  execFileSync("git", [
    "-C",
    seed,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  execFileSync("git", ["clone", "-q", seed, path.join(repos, "demo-repo")]);
  const prevRoot = process.env.WERKMEISTER_ROOT;
  process.env.WERKMEISTER_ROOT = path.resolve(import.meta.dirname, "..", "..", "apps", "cli");
  try {
    await withSandboxHome(
      async () => {
        const { workspacePath } = await createWorkspace(
          { feature: "demo", services: "backend", work_type: "feature" },
          { open: false, cwd: tmp, distill: false, build: false },
        );
        const yml = fs.readFileSync(path.join(dotDir(workspacePath), "workspace.yml"), "utf8");
        assert.match(yml, /^context_strategy: icm$/m);
        assert.ok(fs.existsSync(path.join(workspacePath, "stages")), "ICM layout");
        // SW-66: a container built here outlives the tmp dir and crash-loops on the real daemon.
        if (await dockerAvailable()) {
          const { docker } = await import("./dist/docker.js");
          const made = (await docker().listContainers({ all: true })).filter((c) =>
            c.Labels["com.docker.compose.project.working_dir"]?.includes(path.basename(tmp)),
          );
          assert.deepEqual(
            made.map((c) => c.Names[0]),
            [],
          );
        }
      },
      { config: `paths:\n  repos_root: ${repos}\n  workspaces_root: ${path.join(tmp, "ws")}\n` },
    );
  } finally {
    if (prevRoot === undefined) delete process.env.WERKMEISTER_ROOT;
    else process.env.WERKMEISTER_ROOT = prevRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
