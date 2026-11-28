// SW-957: a relocated WERKMEISTER_CONFIG_FILE is a scratch run. It leaves the person's Claude Desktop
// config alone and reports no drift there, as SW-866 does for ~/.zshenv.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check, desktopConfigPath, patchDesktopConfig } from "../dist/global_config.js";

// It writes the Desktop config under HOME: as scripts/require-temp-home.sh, never a HOME that is a real one.
if (fs.existsSync(path.join(os.homedir(), ".werkmeister")) && os.homedir() !== process.env.TMPDIR)
  throw new Error("run me through with-temp-home");

const STALE = JSON.stringify({
  mcpServers: { werkmeister: { command: "werkmeister", args: ["mcp"], env: { X: "1" } } },
});

/** Seed a stale Desktop config; the cleanup puts back exactly what was there before. */
function seedDesktop(t) {
  const desktop = desktopConfigPath();
  const dir = path.dirname(desktop);
  const hadDir = fs.existsSync(dir);
  const before = fs.existsSync(desktop) ? fs.readFileSync(desktop) : null;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(desktop, STALE);
  t.after(() => {
    if (before !== null) fs.writeFileSync(desktop, before);
    else if (hadDir) fs.rmSync(desktop, { force: true });
    else fs.rmSync(dir, { recursive: true, force: true });
  });
  return desktop;
}

test("a relocated config never rewrites the Desktop config, and check reports no Desktop drift", (t) => {
  const desktop = seedDesktop(t);
  assert.ok(desktop.startsWith(os.homedir()), "the Desktop config is under the temp HOME");
  const scratch = fs.mkdtempSync(path.join(os.homedir(), "scratch-"));
  const prev = process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_CONFIG_FILE = path.join(scratch, "config.yaml");
  fs.writeFileSync(process.env.WERKMEISTER_CONFIG_FILE, "paths: {}\n");
  t.after(() => {
    if (prev === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = prev;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  assert.equal(patchDesktopConfig(), false);
  assert.equal(fs.readFileSync(desktop, "utf8"), STALE, "Desktop config untouched");
  const desktopRows = check({ paths: {} }).filter((p) => p.includes(desktop));
  assert.deepEqual(desktopRows, []);
});

test("the default home still drops the stale env block", (t) => {
  const desktop = seedDesktop(t);
  const prev = process.env.WERKMEISTER_CONFIG_FILE;
  delete process.env.WERKMEISTER_CONFIG_FILE;
  // with-temp-home's own marker would skip it too; this case is the person's real home.
  const marker = process.env.WERKMEISTER_TEMP_HOME;
  delete process.env.WERKMEISTER_TEMP_HOME;
  t.after(() => {
    if (prev !== undefined) process.env.WERKMEISTER_CONFIG_FILE = prev;
    if (marker !== undefined) process.env.WERKMEISTER_TEMP_HOME = marker;
  });

  assert.equal(patchDesktopConfig(), true);
  assert.doesNotMatch(fs.readFileSync(desktop, "utf8"), /"env"/);
});
