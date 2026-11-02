import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkName, oldNameFiles } from "./check-name.mjs";

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

test("oldNameFiles includes untracked files and skips gitignored ones", () => {
  const root = mkdtempSync(join(tmpdir(), "check-name-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "ign.md\n");
  for (const f of ["tracked.md", "new.md", "ign.md"]) writeFileSync(join(root, f), "sandbox\n");
  execFileSync("git", ["add", "tracked.md"], { cwd: root });
  assert.deepEqual(oldNameFiles(root).sort(), ["new.md", "tracked.md"]);
});
