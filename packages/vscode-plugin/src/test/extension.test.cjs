/**
 * The checks that need a running extension host. Everything that can be decided
 * from the manifest or from pure data lives in the `node --test` files instead.
 *
 * Nothing here opens the Workspaces view, so the 5s poll never starts and no
 * `docker ps` sweep runs: the commands are invoked directly with a hand-built
 * node, which is all `pickWorkspace()` needs.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const manifest = require("../../package.json");

/** A directory that stands in for a workspace, plus an executable no-op `sandbox`. */
function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-vsce-"));
  const workspace = path.join(root, name);
  fs.mkdirSync(workspace);
  const bin = path.join(root, "sandbox");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  return { workspace, bin };
}

/** The node shape a tree click passes; only these fields are read. */
const wsNode = (workspace) => ({ workspace: { name: path.basename(workspace), path: workspace } });

suite("Sandbox Workspaces", () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === manifest.name);
    assert.ok(extension, "the extension under development is not loaded");
    await extension.activate();
  });

  teardown(() => {
    for (const term of vscode.window.terminals) term.dispose();
  });

  // A command declared but never registered fails only when someone clicks it,
  // and the failure is a bare "command not found" notification.
  test("every declared command is registered", async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = manifest.contributes.commands
      .map((c) => c.command)
      .filter((id) => !registered.has(id));
    assert.deepEqual(missing, []);
  });

  // The terminal is named for the workspace because it is reused for every
  // later command in that directory — naming it `sandbox stop foo` left `up`
  // and `down` running in a terminal called "stop".
  test("a lifecycle command names its terminal for the workspace, not the command", async () => {
    const { workspace, bin } = fixture("demo-feature");
    // Tests share the extension host's process, so this is the same `process.env`
    // resolveSandboxBin() reads — no fake checkout or settings write needed.
    process.env.SANDBOX_BIN = bin;

    await vscode.commands.executeCommand("sandbox.stop", wsNode(workspace));
    assert.deepEqual(
      vscode.window.terminals.map((t) => t.name),
      ["sandbox demo-feature"],
    );

    await vscode.commands.executeCommand("sandbox.up", wsNode(workspace));
    assert.deepEqual(
      [...new Set(vscode.window.terminals.map((t) => t.name))],
      ["sandbox demo-feature"],
    );
  });
});
