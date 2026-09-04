// The CLI carried a second copy of this walk-up in commands/notes.ts, and
// commands/skills.ts imported it from there -- the one command-to-command
// import edge in the tree. Pinned here so deleting that copy is provably safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { findWorkspaceRoot } from "./dist/gate.js";

test("findWorkspaceRoot walks up to the nearest .sandbox directory", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-")));
  const nested = path.join(root, "repo", "src");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(root, ".sandbox"));

  assert.equal(findWorkspaceRoot(nested), root);
  assert.equal(findWorkspaceRoot(root), root);
});

test("findWorkspaceRoot returns null when no .sandbox exists above start", () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bare-")));
  assert.equal(findWorkspaceRoot(bare), null);
});
