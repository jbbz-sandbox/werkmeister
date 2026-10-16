// `down`'s teardownNotes reads these three; an icm workspace has no
// .sandbox/notes, so each must come back empty rather than throw.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { reconcileGraduating } from "./dist/graduate.js";
import { latestHandoff, openDecisions } from "./dist/notes.js";

test("no notes dir: no handoff, no decisions, nothing graduated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-absent-"));
  try {
    assert.equal(latestHandoff(root), null);
    assert.deepEqual(openDecisions(root), []);
    assert.deepEqual(reconcileGraduating(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
