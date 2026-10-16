// canonical() decides whether the manifest is stale. Order-independence is the
// whole point: a re-serialised manifest with reordered keys is not drift.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { canonical, checkSkills, resolveWorkspaceManifest } from "./dist/workspace_skills.js";

test("canonical sorts object keys at every depth", () => {
  const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
  const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
  assert.equal(JSON.stringify(canonical(a)), JSON.stringify(canonical(b)));
});

test("canonical preserves array order, which is meaningful", () => {
  assert.notEqual(
    JSON.stringify(canonical({ x: [1, 2] })),
    JSON.stringify(canonical({ x: [2, 1] })),
  );
});

test("a workspace with no projected skills is all drift, and reports authoring separately", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "skills-check-"));
  try {
    const result = checkSkills(ws);
    assert.deepEqual(result.authoring, []);
    assert.ok(result.drift.length > 0);
    assert.ok(result.drift.every((e) => e.startsWith("missing: sb-")));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// `sandbox skills sync`/`check` rebuild the manifest without init's args; a
// gate init compiled must survive the next sync, but sync never adds one.
test("the re-resolved manifest carries the work type's phase gate", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "skills-manifest-"));
  try {
    fs.mkdirSync(path.join(ws, ".sandbox"));
    fs.writeFileSync(
      path.join(ws, ".sandbox", "standards.json"),
      JSON.stringify({ phase_gate: { note: "decision", status: "decided" } }),
    );
    const resolved = { active: [], modules: {}, workType: " Feature " };
    assert.deepEqual(resolveWorkspaceManifest(ws, resolved).phase_gate, {
      note: "decision",
      status: "decided",
    });
    const refactor = resolveWorkspaceManifest(ws, { ...resolved, workType: "refactor" });
    assert.ok(!("phase_gate" in refactor));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a workspace whose manifest has no phase gate never gains one on re-resolve", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "skills-manifest-"));
  try {
    const resolved = { active: [], modules: {}, workType: " Feature " };
    assert.ok(!("phase_gate" in resolveWorkspaceManifest(ws, resolved)), "no manifest on disk");
    fs.mkdirSync(path.join(ws, ".sandbox"));
    fs.writeFileSync(path.join(ws, ".sandbox", "standards.json"), JSON.stringify({ domains: {} }));
    assert.ok(!("phase_gate" in resolveWorkspaceManifest(ws, resolved)), "manifest without gate");
    fs.writeFileSync(path.join(ws, ".sandbox", "standards.json"), "{not json");
    assert.ok(!("phase_gate" in resolveWorkspaceManifest(ws, resolved)), "corrupt manifest");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
