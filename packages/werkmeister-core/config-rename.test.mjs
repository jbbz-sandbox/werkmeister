// SW-7: the werkmeister names are read first, the sandbox ones are the
// fallback, and nothing is moved. HOME is a temp dir in every test so the
// developer's real ~/.sandbox is never touched.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  configPath,
  dotDir,
  envVar,
  forDotDir,
  sandboxHome,
  servicesYamlPath,
} from "./dist/config.js";

const VARS = [
  "HOME",
  "SANDBOX_CONFIG_FILE",
  "WERKMEISTER_CONFIG_FILE",
  "SANDBOX_SERVICES_YAML",
  "WERKMEISTER_SERVICES_YAML",
  "SANDBOX_X_TEST",
  "WERKMEISTER_X_TEST",
];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

let home;
beforeEach(() => {
  for (const v of VARS) delete process.env[v];
  home = mkdtempSync(path.join(tmpdir(), "w9r-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v];
  }
});

test("envVar: new name wins, old name is the fallback, unset is undefined", () => {
  assert.equal(envVar("X_TEST"), undefined);
  process.env.SANDBOX_X_TEST = "old";
  assert.equal(envVar("X_TEST"), "old");
  process.env.WERKMEISTER_X_TEST = "new";
  assert.equal(envVar("X_TEST"), "new");
  process.env.WERKMEISTER_X_TEST = "";
  assert.equal(envVar("X_TEST"), "", "a set-but-empty new name still wins");
});

test("dotDir: neither → new name (not created); old only → old; both → new", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "w9r-ws-"));
  assert.equal(dotDir(ws), path.join(ws, ".werkmeister"));
  assert.equal(existsSync(path.join(ws, ".werkmeister")), false);
  mkdirSync(path.join(ws, ".sandbox"));
  assert.equal(dotDir(ws), path.join(ws, ".sandbox"));
  mkdirSync(path.join(ws, ".werkmeister"));
  assert.equal(dotDir(ws), path.join(ws, ".werkmeister"));
});

test("global home: ~/.sandbox is read in place when ~/.werkmeister is missing", () => {
  assert.equal(sandboxHome(), path.join(home, ".werkmeister"), "fresh machine gets the new dir");
  mkdirSync(path.join(home, ".sandbox"));
  assert.equal(configPath(), path.join(home, ".sandbox", "config.yaml"));
  mkdirSync(path.join(home, ".werkmeister"));
  assert.equal(configPath(), path.join(home, ".werkmeister", "config.yaml"));
});

test("either *_CONFIG_FILE relocates the home; the new one wins", () => {
  process.env.SANDBOX_CONFIG_FILE = path.join(home, "old", "config.yaml");
  assert.equal(sandboxHome(), path.join(home, "old"));
  process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "new", "config.yaml");
  assert.equal(sandboxHome(), path.join(home, "new"));
});

test("a registry env override reads the new name first", () => {
  process.env.SANDBOX_CONFIG_FILE = path.join(home, "none", "config.yaml");
  process.env.SANDBOX_SERVICES_YAML = "/old/services.yaml";
  assert.equal(servicesYamlPath(), "/old/services.yaml");
  process.env.WERKMEISTER_SERVICES_YAML = "/new/services.yaml";
  assert.equal(servicesYamlPath(), "/new/services.yaml");
});

test("forDotDir: rewrites workspace mentions only, and only in a .werkmeister workspace", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "w9r-ws-"));
  const text =
    "read `.sandbox/issue.md` and ../../.sandbox/sandbox-context.md\n" +
    ".sandbox/notes/ | (.sandbox/x) — not ~/.sandbox/services.yaml or $HOME/.sandbox/env.sh";
  mkdirSync(path.join(ws, ".sandbox"));
  assert.equal(forDotDir(text, ws), text, "identity in a .sandbox workspace");
  mkdirSync(path.join(ws, ".werkmeister"));
  assert.equal(
    forDotDir(text, ws),
    "read `.werkmeister/issue.md` and ../../.werkmeister/sandbox-context.md\n" +
      ".werkmeister/notes/ | (.werkmeister/x) — not ~/.sandbox/services.yaml or $HOME/.sandbox/env.sh",
  );
});
