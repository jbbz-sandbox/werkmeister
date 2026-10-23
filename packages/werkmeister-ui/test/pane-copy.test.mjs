// The pane plugin can't import this package (its loader refuses files outside the plugin folder), so it keeps a
// copy of the display model. This fails when the copy drifts from src/. Run: node --test test/pane-copy.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const MARKER = "/** `needs` is the solid-amber chip";
const body = (rel) => {
  const text = fs.readFileSync(new URL(rel, import.meta.url), "utf8");
  const at = text.indexOf(MARKER);
  assert.notEqual(at, -1, `${rel} has no "${MARKER}" line`);
  return text.slice(at);
};

test("plugins/werkmeister/hooks/display-model.ts is display-model.ts from the Tone comment down", () => {
  assert.equal(
    body("../../../plugins/werkmeister/hooks/display-model.ts"),
    body("../src/display-model.ts"),
    "the pane's copy drifted: copy packages/sandbox-ui/src/display-model.ts over it from the Tone comment down",
  );
});
