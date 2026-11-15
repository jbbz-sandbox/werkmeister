import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleProblems } from "../typedoc-require-example.mjs";

const TODO = "apps/docs-site/sdk-example-todo.txt";
const ok = { id: "functions/up", hasExample: true };
const bare = { id: "functions/down", hasExample: false };

test("exampleProblems passes when every export has an @example", () => {
  assert.deepEqual(exampleProblems([ok], []), []);
});

test("exampleProblems names an export with no @example", () => {
  assert.deepEqual(exampleProblems([ok, bare], []), [
    "functions/down: SDK export has no @example importing werkmeister-core/sdk",
  ]);
});

test("exampleProblems excuses an export the todo list names", () => {
  assert.deepEqual(exampleProblems([ok, bare], ["functions/down"]), []);
});

test("exampleProblems wants a todo line deleted once its export has an @example", () => {
  assert.deepEqual(exampleProblems([ok], ["functions/up"]), [
    `functions/up: has an @example now; delete its line from ${TODO}`,
  ]);
});

test("exampleProblems names a todo line that is not exported", () => {
  assert.deepEqual(exampleProblems([ok], ["functions/gone"]), [
    `functions/gone: listed in ${TODO} but not exported`,
  ]);
});
