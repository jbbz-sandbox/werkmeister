// icm.refresh is the repair path for a workspace a pre-strategy `up` polluted
// with JIT hooks. It removes exactly the sandbox-managed entries.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { PRE_TOOL_USE_GATE_COMMAND, SESSION_START_COMMAND } from "./dist/hooks_gen.js";
import { strategyById } from "./dist/strategies/index.js";

const icm = strategyById("icm");
const HAND = { hooks: [{ type: "command", command: "echo mine" }] };

function workspace(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-refresh-"));
  fs.mkdirSync(path.join(root, ".claude"));
  fs.mkdirSync(path.join(root, ".sandbox", ".gate"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sandbox", ".gate", "s.json"), "{}");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  return root;
}

async function refresh(root) {
  const c = collectingReporter();
  await withReporter(c, async () => icm.refresh(root));
  return c.text();
}

test("keeps the hand-added hook, drops the managed ones and .gate", async () => {
  const root = workspace({
    hooks: {
      SessionStart: [HAND, { hooks: [{ type: "command", command: SESSION_START_COMMAND }] }],
      PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: PRE_TOOL_USE_GATE_COMMAND }] }],
    },
  });
  try {
    const log = await refresh(root);
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings, { hooks: { SessionStart: [HAND] } });
    assert.ok(!fs.existsSync(path.join(root, ".sandbox", ".gate")));
    assert.match(log, /sandbox notes context/);
    assert.match(log, /sandbox hooks gate/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only managed hooks: settings.json and the empty .claude/ go", async () => {
  const root = workspace({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: SESSION_START_COMMAND }] }] } });
  try {
    await refresh(root);
    assert.ok(!fs.existsSync(path.join(root, ".claude")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unparseable settings.json is left untouched", async () => {
  const root = workspace("{ not json");
  try {
    await refresh(root);
    assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"), "{ not json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace with no .claude/ stays without one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-refresh-"));
  try {
    await refresh(root);
    assert.ok(!fs.existsSync(path.join(root, ".claude")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// icm.init now calls refresh() itself at the end (a jit->icm switch without
// --prune-context otherwise leaves jit's hooks live until the next `up`,
// which would then run icm's sync over hand-edited stage contracts). That
// must stay silent on a clean workspace, or every icm init would print noise.
test("refresh on a clean workspace (no .claude, no .gate) logs nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-refresh-clean-"));
  try {
    const log = await refresh(root);
    assert.equal(log, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
