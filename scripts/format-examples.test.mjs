import assert from "node:assert/strict";
import { test } from "node:test";
import { formatExamples } from "./format-examples.mjs";

/** A TSDoc comment whose `@example` holds `code`, indented like a class member's. */
const doc = (code) =>
  [
    "  /**",
    "   * Does a thing.",
    "   *",
    "   * @example",
    "   * ```ts",
    ...code.split("\n").map((l) => (l ? `   * ${l}` : "   *")),
    "   * ```",
    "   */",
    "  run(): void {}",
    "",
  ].join("\n");

test("formats an ugly example in place, keeping the comment's indent", async () => {
  const before = doc(
    'import { up } from "werkmeister-core/sdk";\nconst   x = await up( )\nif(x){console.log( x )}',
  );
  const { text, changed } = await formatExamples(before);
  assert.equal(changed, 1);
  assert.equal(
    text,
    doc(
      'import { up } from "werkmeister-core/sdk";\nconst x = await up();\nif (x) {\n  console.log(x);\n}',
    ),
  );
});

test("leaves a fragment it cannot parse as it is", async () => {
  const before = doc("const { a } = await up(\n// …and so on");
  assert.deepEqual(await formatExamples(before), { text: before, changed: 0, skipped: 1 });
});

test("leaves a formatted example unchanged", async () => {
  const before = doc('import { up } from "werkmeister-core/sdk";\n\nawait up();');
  assert.deepEqual(await formatExamples(before), { text: before, changed: 0, skipped: 0 });
});

test("fails when biome cannot run, so a check never passes unchecked", async () => {
  await assert.rejects(
    formatExamples(doc("const   x = 1"), "/nonexistent/biome"),
    /could not run \/nonexistent\/biome/,
  );
});
