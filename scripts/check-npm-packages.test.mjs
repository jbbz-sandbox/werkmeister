import assert from "node:assert/strict";
import { test } from "node:test";
import { missingOnNpm } from "./check-npm-packages.mjs";

const pkgs = [
  { name: "werkmeister", private: false },
  { name: "werkmeister-core" },
  { name: "werkmeister-mcp", private: true },
];
/** A fake `npm view <name> name`: 0 for names on npm, E404 for the rest. */
const view = (onNpm) => (name) =>
  onNpm.includes(name)
    ? { status: 0, stdout: `${name}\n`, stderr: "" }
    : { status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" };

test("every public package on npm: nothing missing, private ones never looked up", () => {
  const asked = [];
  const v = view(["werkmeister", "werkmeister-core"]);
  assert.deepEqual(
    missingOnNpm(pkgs, (n) => {
      asked.push(n);
      return v(n);
    }),
    [],
  );
  assert.deepEqual(asked, ["werkmeister", "werkmeister-core"]);
});

test("a public package not on npm is missing, with why", () => {
  assert.deepEqual(missingOnNpm(pkgs, view(["werkmeister"])), [
    { name: "werkmeister-core", why: "not on npm (E404)" },
  ]);
});

test("a lookup that fails for another reason is missing too, with its error", () => {
  const down = () => ({ status: 1, stdout: "", stderr: "npm error code ETIMEDOUT\nmore" });
  assert.deepEqual(missingOnNpm(pkgs.slice(0, 1), down), [
    { name: "werkmeister", why: "npm view failed: npm error code ETIMEDOUT" },
  ]);
});
