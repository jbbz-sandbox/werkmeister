// `sandbox setup` installs tab completion into ~/.zshrc as a managed block.
// Pinned here because it edits a file the user also owns: re-running must
// replace its own block and nothing else, and the block must be valid zsh on a
// machine where `sandbox` is not (yet) on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureZshrcCompletion } from "./dist/global_config.js";

const rcIn = (dir) => path.join(dir, ".zshrc");
const scratch = () => mkdtempSync(path.join(tmpdir(), "zshrc-"));

test("creates the block, and is a no-op the second time", () => {
  const rc = rcIn(scratch());
  assert.equal(ensureZshrcCompletion(rc), true);
  assert.match(readFileSync(rc, "utf8"), /complete -C 'sandbox __complete' sandbox/);
  assert.equal(ensureZshrcCompletion(rc), false);
});

test("replaces a prior block, keeping the user's own lines", () => {
  const rc = rcIn(scratch());
  ensureZshrcCompletion(rc);
  const stale = readFileSync(rc, "utf8").replace("__complete", "__old_complete");
  writeFileSync(rc, `alias ll='ls -l'\n${stale}export EDITOR=vim\n`);

  assert.equal(ensureZshrcCompletion(rc), true);
  const text = readFileSync(rc, "utf8");
  assert.ok(!text.includes("__old_complete"), "stale block survived");
  assert.equal(text.match(/# >>> sandbox completion >>>/g).length, 1);
  assert.match(text, /alias ll='ls -l'/);
  assert.match(text, /export EDITOR=vim/);
});

test("the block is valid zsh even with no sandbox on PATH", (t) => {
  const zsh = spawnSync("which", ["zsh"], { encoding: "utf8" }).stdout.trim();
  if (!zsh) return t.skip("no zsh");
  const dir = scratch();
  const rc = rcIn(dir);
  ensureZshrcCompletion(rc);
  // -f: no user rc files, so only the block under test runs. PATH points at an
  // empty dir (absolute zsh, so the spawn itself still resolves) to take the
  // `sandbox`-absent branch, which must still exit clean.
  const res = spawnSync(zsh, ["-f", "-c", `source ${rc}`], { env: { PATH: dir }, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});
