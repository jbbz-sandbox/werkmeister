// The rename to compose.yml (#224) must never orphan a stack: lookup falls back
// to the legacy name, and migration never clobbers an existing compose.yml.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  COMPOSE_FILE,
  findWorkspaceCompose,
  LEGACY_COMPOSE_FILE,
  migrateWorkspaceCompose,
} from "./dist/compose_file.js";

function workspace(files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "compose-file-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(ws, name), body);
  return ws;
}

test("lookup prefers compose.yml, falls back to the legacy name, else null", () => {
  assert.equal(findWorkspaceCompose(workspace({})), null);
  const legacy = workspace({ [LEGACY_COMPOSE_FILE]: "" });
  assert.equal(findWorkspaceCompose(legacy), path.join(legacy, LEGACY_COMPOSE_FILE));
  const both = workspace({ [LEGACY_COMPOSE_FILE]: "", [COMPOSE_FILE]: "" });
  assert.equal(findWorkspaceCompose(both), path.join(both, COMPOSE_FILE));
});

test("migration renames the legacy file and keeps its contents", () => {
  const ws = workspace({ [LEGACY_COMPOSE_FILE]: "name: sandbox-demo\n" });
  migrateWorkspaceCompose(ws);
  assert.deepEqual(fs.readdirSync(ws), [COMPOSE_FILE]);
  assert.equal(fs.readFileSync(path.join(ws, COMPOSE_FILE), "utf8"), "name: sandbox-demo\n");
});

test("migration leaves both files alone when compose.yml already exists", () => {
  const ws = workspace({ [LEGACY_COMPOSE_FILE]: "old", [COMPOSE_FILE]: "new" });
  migrateWorkspaceCompose(ws);
  assert.equal(fs.readFileSync(path.join(ws, COMPOSE_FILE), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(ws, LEGACY_COMPOSE_FILE), "utf8"), "old");
});

test("migration is a no-op on a workspace with neither file", () => {
  const ws = workspace({});
  migrateWorkspaceCompose(ws);
  assert.deepEqual(fs.readdirSync(ws), []);
});
