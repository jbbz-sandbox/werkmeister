import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleProblems } from "../typedoc-require-example.mjs";

const ok = { id: "functions/up", hasExample: true };
const bare = { id: "functions/down", hasExample: false };

test("exampleProblems passes when every export has an @example", () => {
  assert.deepEqual(exampleProblems([ok]), []);
});

test("exampleProblems names an export with no @example", () => {
  assert.deepEqual(exampleProblems([ok, bare]), [
    "functions/down: SDK export has no @example importing werkmeister-core/sdk",
  ]);
});
