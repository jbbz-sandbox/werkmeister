// `down`'s teardownNotes reads these; a workspace with no .werkmeister/notes
// must come back empty rather than throw. icm reads its decisions from stage
// outputs instead, so offers them anyway (icm-graduate.test.mjs).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { reconcileGraduating } from "./dist/graduate.js";
import { latestHandoff, openDecisions } from "./dist/notes.js";
import { strategyById } from "./dist/strategies/index.js";

test("no notes dir: no handoff, no decisions, nothing graduated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-absent-"));
  try {
    assert.equal(latestHandoff(root), null);
    assert.deepEqual(openDecisions(root), []);
    assert.deepEqual(reconcileGraduating(root), []);
    assert.deepEqual(strategyById("icm").decisions.open(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
