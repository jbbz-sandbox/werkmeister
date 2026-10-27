import assert from "node:assert/strict";
import { test } from "node:test";
import { checkName } from "./check-name.mjs";

const check = (text, rel = "apps/cli/src/x.ts") => checkName(rel, text);

test("flags the old name in prose, paths, commands and env names", () => {
  assert.equal(check("Not inside a sandbox workspace").length, 1);
  assert.equal(check("see `.sandbox/notes/`").length, 1);
  assert.equal(check("run `sandbox config`").length, 1);
  assert.equal(check("export SANDBOX_ROOT=x").length, 1);
  assert.equal(check("paths.sandbox_root").length, 1);
});

test("keeps identifiers, the kept names and opted-out lines", () => {
  assert.deepEqual(
    check("throw new SandboxError(msg); withSandboxHome(); __sandboxCreateRequire"),
    [],
  );
  assert.deepEqual(check('import { x } from "werkmeister-core/sandbox";'), []);
  assert.deepEqual(check('"types": "dist/sandbox.d.ts"'), []);
  assert.deepEqual(check("https://github.com/jbbz-sandbox/werkmeister"), []);
  assert.deepEqual(check("process.env.SANDBOX_FEATURE ?? headers['x-sandbox-feature']"), []);
  assert.deepEqual(check("clones <org>/sandbox-workspace"), []);
  assert.deepEqual(check('"sandbox " // name-check: ignore'), []);
});

test("keeps VS Code IDs only in the extension", () => {
  const ids = '"command": "sandbox.refresh", getConfiguration("sandbox")';
  assert.deepEqual(check(ids, "packages/werkmeister-vscode/package.json"), []);
  assert.equal(check(ids).length, 1);
});
