// SW-7 / SW-106: the werkmeister names are the only ones read. HOME is a temp
// dir in every test so the developer's real ~/.werkmeister is never touched.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { configPath, dotDir, envVar, sandboxHome, servicesYamlPath } from "./dist/config.js";

const VARS = ["HOME", "WERKMEISTER_CONFIG_FILE", "WERKMEISTER_SERVICES_YAML", "WERKMEISTER_X_TEST"];
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

test("envVar reads WERKMEISTER_<name>; unset is undefined", () => {
  assert.equal(envVar("X_TEST"), undefined);
  process.env.WERKMEISTER_X_TEST = "set";
  assert.equal(envVar("X_TEST"), "set");
  process.env.WERKMEISTER_X_TEST = "";
  assert.equal(envVar("X_TEST"), "", "set-but-empty is kept");
});

test("dotDir is <parent>/.werkmeister and is not created", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "w9r-ws-"));
  assert.equal(dotDir(ws), path.join(ws, ".werkmeister"));
  assert.equal(existsSync(path.join(ws, ".werkmeister")), false);
});

test("global home is ~/.werkmeister", () => {
  assert.equal(sandboxHome(), path.join(home, ".werkmeister"));
  assert.equal(configPath(), path.join(home, ".werkmeister", "config.yaml"));
});

test("WERKMEISTER_CONFIG_FILE relocates the home", () => {
  process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "elsewhere", "config.yaml");
  assert.equal(sandboxHome(), path.join(home, "elsewhere"));
});

test("WERKMEISTER_SERVICES_YAML overrides the registry path", () => {
  process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "none", "config.yaml");
  process.env.WERKMEISTER_SERVICES_YAML = "/x/services.yaml";
  assert.equal(servicesYamlPath(), "/x/services.yaml");
});
