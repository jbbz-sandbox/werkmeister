import assert from "node:assert/strict";
import { test } from "node:test";
import { braceLines } from "./check-docs.mjs";

test("braceLines names a {{ in prose and in an inline code span, which help.md carries into cli-reference", () => {
  const text = ["Plain {{x}} here.", "", "Run `{{at:<stage>}}` at the stage."].join("\n");
  assert.deepEqual(
    braceLines("docs/cli-reference.md", text).map((p) => p.split(":").slice(0, 2).join(":")),
    ["docs/cli-reference.md:1", "docs/cli-reference.md:3"],
  );
});

test("braceLines passes a {{ inside a fence or <code v-pre>", () => {
  const text = [
    "```yaml",
    "a: {{b}}",
    "```",
    "~~~",
    "{{c}}",
    "~~~",
    "Use <code v-pre>{{at:x}}</code> here.",
  ].join("\n");
  assert.deepEqual(braceLines("docs/x.md", text), []);
});
