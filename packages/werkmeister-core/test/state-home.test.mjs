// SW-622: WERKMEISTER_CONFIG_FILE moves every ~/.werkmeister path, not only config.yaml.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { sandboxLock } from "../dist/locks.js";

test("a lock taken under a relocated config writes nothing under HOME's ~/.werkmeister", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "state-home-"));
  const prev = { HOME: process.env.HOME, CFG: process.env.WERKMEISTER_CONFIG_FILE };
  const home = path.join(tmp, "home");
  const relocated = path.join(tmp, "demo", ".werkmeister");
  process.env.HOME = home;
  process.env.WERKMEISTER_CONFIG_FILE = path.join(relocated, "config.yaml");
  try {
    await sandboxLock("x", async () => {});
    assert.equal(fs.existsSync(path.join(home, ".werkmeister")), false);
    assert.ok(fs.existsSync(path.join(relocated, "locks")));
  } finally {
    process.env.HOME = prev.HOME;
    if (prev.CFG === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = prev.CFG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("no source builds a ~/.werkmeister path from HOME outside config.ts", () => {
  const repo = path.resolve(import.meta.dirname, "../../..");
  const bad = /dotDir\(\s*(os\.)?homedir\(\)\s*\)|homedir\(\)[^\n]*["']\.werkmeister/;
  const hits = [];
  for (const top of ["packages", "apps"]) {
    for (const pkg of fs.readdirSync(path.join(repo, top))) {
      const src = path.join(repo, top, pkg, "src");
      if (!fs.existsSync(src)) continue;
      for (const rel of fs.readdirSync(src, { recursive: true })) {
        const file = path.join(src, rel);
        if (!/\.(ts|tsx|mjs|js)$/.test(file) || /__tests__|\.test\./.test(file)) continue;
        if (file.endsWith(path.join("werkmeister-core", "src", "config.ts"))) continue;
        if (bad.test(fs.readFileSync(file, "utf8"))) hits.push(path.relative(repo, file));
      }
    }
  }
  assert.deepEqual(hits, [], "use sandboxHome() from werkmeister-core/config");
});
