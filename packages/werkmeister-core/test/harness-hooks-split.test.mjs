// SW-538: hooksAvailable is a pure predicate; only the hook writers (init, refresh) write
// OpenCode's own hook files, so pause no longer rewrites opencode.json as a side effect.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { hooksAvailable } from "../dist/harness/layout.js";
import { OPENCODE_PLUGIN_PATH } from "../dist/harness/opencode/hooks.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { jit } from "../dist/strategies/jit.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const workspace = (harness) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-split-"));
  fs.mkdirSync(path.join(root, ".werkmeister"));
  fs.writeFileSync(
    path.join(root, ".werkmeister", "workspace.yml"),
    `context_strategy: jit\nharness: ${harness}\n`,
  );
  return root;
};
const ocFiles = (root) => ["opencode.json", OPENCODE_PLUGIN_PATH].map((p) => path.join(root, p));

test("hooksAvailable writes and prints nothing, on every harness", () => {
  for (const [harness, want] of [
    ["opencode", false],
    ["mcp", false],
    ["claude", true],
  ]) {
    const root = workspace(harness);
    try {
      const reporter = collectingReporter();
      assert.equal(
        withReporter(reporter, () => hooksAvailable(root)),
        want,
        harness,
      );
      assert.equal(reporter.text(), "", `${harness} printed`);
      for (const f of ocFiles(root)) assert.ok(!fs.existsSync(f), `${harness} wrote ${f}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("jit refresh still writes the OpenCode plugin and opencode.json", async () => {
  const root = workspace("opencode");
  try {
    await withSandboxHome(() => withReporter(collectingReporter(), () => jit.refresh(root)));
    for (const f of ocFiles(root)) {
      assert.ok(fs.existsSync(f), `missing ${f}`);
      assert.ok(f.startsWith(root + path.sep), `${f} outside the temp root`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pause's check leaves an existing opencode.json untouched", () => {
  const root = workspace("opencode");
  try {
    const config = path.join(root, "opencode.json");
    fs.writeFileSync(config, '{"sentinel":1}\n');
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(config, old, old);
    // The path ran: opencode answers false, so pause skips the Claude agent-state write.
    assert.equal(
      withReporter(collectingReporter(), () => hooksAvailable(root)),
      false,
    );
    assert.equal(fs.readFileSync(config, "utf8"), '{"sentinel":1}\n');
    assert.equal(fs.statSync(config).mtimeMs, old.getTime());
    assert.ok(!fs.existsSync(path.join(root, OPENCODE_PLUGIN_PATH)), "plugin written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pause calls only the pure predicate", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "lifecycle.ts"), "utf8");
  assert.match(src, /if \(hooksAvailable\(workspace\)\) writeAgentStateHooks\(workspace\);/);
  assert.doesNotMatch(src, /writeHarnessHooks\(/);
});
