// The config search decides which directory playwright runs in, and whether it
// runs at all: wrong runs the wrong suite, or none, and reports success either way.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  installedPlaywrightVersion,
  playwrightCwd,
  playwrightSearchDirs,
  runFeatureTests,
} from "./dist/test_run.js";
import { withSandboxHome } from "./fixtures.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pw-"));

test("prefers the workspace root when it holds a playwright config", () => {
  const ws = tmp(),
    repo = path.join(ws, "r");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(ws, "playwright.config.ts"), "");
  fs.writeFileSync(path.join(repo, "playwright.config.ts"), "");
  assert.equal(playwrightCwd([ws, repo]), ws);
});

test("finds a config in a repo worktree", () => {
  const ws = tmp(),
    repo = path.join(ws, "r");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, "playwright.config.js"), "");
  assert.deepEqual(playwrightSearchDirs(ws), [ws, repo]);
  assert.equal(playwrightCwd(playwrightSearchDirs(ws)), repo);
});

test("recognises all three config spellings", () => {
  for (const name of ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, name), "");
    assert.equal(playwrightCwd([ws]), ws, `${name} not recognised`);
  }
});

test("no config anywhere means no cwd, never a fallback root", () => {
  assert.equal(playwrightCwd([tmp(), tmp()]), null);
  assert.equal(playwrightCwd(["/definitely/not/here"]), null);
});

test("with no suite nothing is spawned and the message lists each service's guidance", async () => {
  await withSandboxHome(
    async () => {
      const ws = tmp(),
        repo = path.join(ws, "demo");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      const result = await runFeatureTests({ feature: "nosuite", workspace: ws });
      assert.equal(result.status, 1);
      assert.equal(result.cwd, null);
      assert.match(result.message, /No Playwright suite found/);
      assert.match(result.message, /- lib — test: npm test — validate: run the smoke tests/);
    },
    {
      services: `services:
  lib:
    type: library
    repo: demo
    path: .
    archetype: tool
    validate: run the smoke tests
repos:
  demo:
    services: [lib]
archetypes:
  tool:
    test: npm test
`,
    },
  );
});

// The mismatch warning hinges on this: a hoisted install must still count.
test("finds @playwright/test hoisted to a parent node_modules", () => {
  const root = tmp(),
    ws = path.join(root, "ws");
  const pkg = path.join(root, "node_modules", "@playwright", "test");
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(ws);
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@playwright/test", version: "9.9.9" }),
  );
  assert.equal(installedPlaywrightVersion(ws), "9.9.9");
});

test("reports no version when @playwright/test is not installed", () => {
  assert.equal(installedPlaywrightVersion(tmp()), null);
});
