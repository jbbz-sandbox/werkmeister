// The gate's whole value is failing when there is nothing to check. A missing or
// empty tree reporting "0 modules checked" and exiting 0 is the bug this guards.
//
// `moduleCount === 0` is also the CLI's render discriminator: those two paths
// print the bare message, every other failure prints the "N problem(s)" header
// and an indented list. Pinned here so a change to either shape is caught in
// core rather than as a silent formatting drift in `sandbox standards check`.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkStandards } from "./dist/standards.js";

/**
 * Run `fn` with the standards tree pointed at `standardsDir`.
 *
 * The temp home gets its own services.yaml as well: `validateServiceStandards`
 * reads the registry, so borrowing the developer's would make the assertions
 * depend on whatever archetypes that machine happens to declare.
 */
function withStandardsDir(standardsDir, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-standards-"));
  const cfg = path.join(home, "config.yaml");
  fs.writeFileSync(cfg, `version: 1\noverrides:\n  standards_dir: ${standardsDir}\n`);
  fs.writeFileSync(path.join(home, "services.yaml"), "services:\n  demo:\n    type: api\n");
  const prev = process.env.SANDBOX_CONFIG_FILE;
  process.env.SANDBOX_CONFIG_FILE = cfg;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_CONFIG_FILE;
    else process.env.SANDBOX_CONFIG_FILE = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("checkStandards returns errors as data and never exits", () => {
  const result = checkStandards();
  assert.equal(typeof result.dir, "string");
  assert.equal(typeof result.moduleCount, "number");
  assert.ok(Array.isArray(result.errors));
});

test("a well-formed tree reports no errors and a non-zero module count", () => {
  const result = checkStandards();
  if (result.errors.length) {
    assert.fail(`this repo's standards tree should be clean: ${result.errors.join("; ")}`);
  }
  assert.ok(result.moduleCount > 0, "an empty tree must not read as success");
});

test("a missing tree is one error, not a silent success", () => {
  const dir = path.join(os.tmpdir(), "sandbox-standards-does-not-exist");
  const result = withStandardsDir(dir, checkStandards);
  assert.equal(result.dir, dir);
  assert.equal(result.moduleCount, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^standards tree not found: /);
});

test("an existing but empty tree is one error, not '0 modules checked'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-empty-tree-"));
  try {
    const result = withStandardsDir(dir, checkStandards);
    assert.equal(result.moduleCount, 0);
    assert.deepEqual(result.errors, [`no standard modules found in ${dir}`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed module is reported alongside a non-zero module count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-bad-tree-"));
  try {
    fs.writeFileSync(path.join(dir, "bogus.md"), "---\ndomain: bogus\n---\n\nBody.\n");
    const result = withStandardsDir(dir, checkStandards);
    // Non-zero count is what tells the CLI to use the "N problem(s)" header.
    assert.equal(result.moduleCount, 1);
    assert.ok(
      result.errors.some((e) => e.startsWith("bogus.md: missing or empty `summary:`")),
      `expected the frontmatter errors, got: ${result.errors.join("; ")}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
