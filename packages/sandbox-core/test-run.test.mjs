// The config search decides which directory playwright runs in. Getting it
// wrong runs the wrong suite, or none, and reports success either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { installedPlaywrightVersion, playwrightCwd } from "./dist/test_run.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pw-"));

test("prefers the workspace when it holds a playwright config", () => {
  const ws = tmp(), root = tmp();
  fs.writeFileSync(path.join(ws, "playwright.config.ts"), "");
  fs.writeFileSync(path.join(root, "playwright.config.ts"), "");
  assert.equal(playwrightCwd(ws, root), ws);
});

test("falls back to the sandbox root when the workspace has no config", () => {
  const ws = tmp(), root = tmp();
  fs.writeFileSync(path.join(root, "playwright.config.js"), "");
  assert.equal(playwrightCwd(ws, root), root);
});

test("recognises all three config spellings", () => {
  for (const name of ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) {
    const ws = tmp();
    fs.writeFileSync(path.join(ws, name), "");
    assert.equal(playwrightCwd(ws, "/some/root"), ws, `${name} not recognised`);
  }
});

test("falls back to the root when neither has a config", () => {
  assert.equal(playwrightCwd(tmp(), "/some/root"), "/some/root");
});

test("a workspace that does not exist is not selected", () => {
  assert.equal(playwrightCwd("/definitely/not/here", "/some/root"), "/some/root");
});

// The mismatch warning hinges on this: a hoisted install must still count.
test("finds @playwright/test hoisted to a parent node_modules", () => {
  const root = tmp(), ws = path.join(root, "ws");
  const pkg = path.join(root, "node_modules", "@playwright", "test");
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@playwright/test", version: "9.9.9" }));
  assert.equal(installedPlaywrightVersion(ws), "9.9.9");
});

test("reports no version when @playwright/test is not installed", () => {
  assert.equal(installedPlaywrightVersion(tmp()), null);
});
