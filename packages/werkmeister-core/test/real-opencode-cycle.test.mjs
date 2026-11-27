// SW-537: the OpenCode lifecycle end to end on the real binary, which SW-385 checked once by hand.
// Opt-in: it spends model turns, so it runs only with WERKMEISTER_REAL_OPENCODE=1, a logged-in
// OpenCode (docs/harnesses.md § OpenCode step 1) and WERKMEISTER_OPENCODE_MODEL=<provider/model>.
// Under with-temp-home HOME is already temporary, so also pass OPENCODE_BIN, XDG_DATA_HOME and
// XDG_CONFIG_HOME pointing at the real install and login.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { opencodeAdapter } from "../dist/harness/opencode/index.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

// Read before the fixture swaps HOME: the binary and the login live in the person's real dirs.
const realHome = os.homedir();
const realBin = process.env.OPENCODE_BIN || path.join(realHome, ".opencode", "bin", "opencode");
const xdg = {
  XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(realHome, ".local", "share"),
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(realHome, ".config"),
};
const model = process.env.WERKMEISTER_OPENCODE_MODEL;
// The plugin calls the installed werkmeister: core tests never read another package's build (SW-1063).
const callerPath = process.env.PATH;

const executable = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const script = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
};

test("opencode: init, two turns on one session, a denied shell command, card done, sessions deleted", {
  skip: process.env.WERKMEISTER_REAL_OPENCODE !== "1" && "set WERKMEISTER_REAL_OPENCODE=1 to run",
}, async (t) => {
  if (!executable(realBin)) return t.skip(`no opencode binary at ${realBin}`);
  if (!model?.includes("/")) return t.skip("set WERKMEISTER_OPENCODE_MODEL=<provider/model>");
  await withFixtureWorkspace(async (fx) => {
    const home = process.env.HOME;
    // childEnv() puts /usr/local/bin ahead of the caller's PATH, so the plugin's `werkmeister` goes
    // in the fixture HOME's ~/.local/bin, resolved on the caller's PATH.
    script(
      path.join(home, ".local", "bin", "werkmeister"),
      `PATH="${callerPath}" exec werkmeister "$@"`,
    );
    // --standalone runs the plugin in this fixture's env, not the person's background service;
    // the XDG dirs point OpenCode at the real login while HOME is the fixture's.
    const wrapper = script(
      path.join(home, "opencode-wrapper"),
      `export XDG_DATA_HOME="${xdg.XDG_DATA_HOME}" XDG_CONFIG_HOME="${xdg.XDG_CONFIG_HOME}"
if [ "$1" = run ]; then shift; exec "${realBin}" run --standalone "$@"; fi
exec "${realBin}" "$@"`,
    );
    process.env.OPENCODE_BIN = wrapper;
    // The fake gh, ahead of the real one and its login (the real XDG_CONFIG_HOME): a merge that gets
    // past the deny shows in its log.
    fs.symlinkSync(process.env.WERKMEISTER_GH_BIN, path.join(home, ".local", "bin", "gh"));
    // opencode.json's MCP url takes this port: the fixture's dead daemon, never the host's on 3002.
    process.env.WERKMEISTER_MCP_PORT = new URL(process.env.WERKMEISTER_HOST).port;
    const ws = fx.workspace;
    fs.appendFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "harness: opencode\n");
    await withReporter(collectingReporter(), () => initWorkspace({}, ws, { build: false }));

    const marker = path.join(ws, "merged.marker");
    let ids = [];
    try {
      await opencodeAdapter.sendTurn("oc-real", ws, "Reply with the word ok.", null, model, {
        wait: true,
      });
      const [first] = await opencodeAdapter.listSessions(ws);
      assert.ok(first?.sessionId, "turn 1 left no session");
      ids = [first.sessionId];
      await opencodeAdapter.sendTurn(
        "oc-real",
        ws,
        `Run exactly this one shell command and nothing else: gh pr merge 1 && touch ${marker}`,
        first.sessionId,
        model,
        { wait: true },
      );
      const sessions = await opencodeAdapter.listSessions(ws);
      ids = sessions.map((s) => s.sessionId);
      assert.deepEqual(ids, [first.sessionId], "turn 2 started a new session");
      assert.ok(!fs.existsSync(marker), "the denied command ran");
      const ghCalls = fs.existsSync(fx.ghLog) ? fs.readFileSync(fx.ghLog, "utf8") : "";
      assert.doesNotMatch(ghCalls, /pr merge/, "gh pr merge got past the deny");
      // The plugin's agent-state hook kept a record, and the finished turn reads done.
      assert.ok(fs.readdirSync(path.join(ws, ".werkmeister", "sessions")).length > 0);
      assert.equal((await opencodeAdapter.agentSignal("oc-real", ws, null)).signal.agent, "done");
    } finally {
      // Without the plugin, the person's background service (which `session delete` goes to) runs no
      // werkmeister hook for this folder, so nothing reaches the real ~/.werkmeister.
      fs.rmSync(path.join(ws, "opencode.json"), { force: true });
      fs.rmSync(path.join(ws, ".opencode"), { recursive: true, force: true });
      for (const id of ids)
        await promisify(execFile)(wrapper, ["session", "delete", id]).catch(() => {});
    }
  });
});
