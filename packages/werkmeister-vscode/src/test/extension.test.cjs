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
    process.env.WERKMEISTER_BIN = bin;

    await vscode.commands.executeCommand("sandbox.stop", wsNode(workspace));
    assert.deepEqual(
      vscode.window.terminals.map((t) => t.name),
      ["werkmeister demo-feature"],
    );

    await vscode.commands.executeCommand("sandbox.up", wsNode(workspace));
    assert.deepEqual(
      [...new Set(vscode.window.terminals.map((t) => t.name))],
      ["werkmeister demo-feature"],
    );
  });

  // ⚡ Connect infra is view-wide (SW-55): no workspace cwd to name its terminal after.
  test("Connect infra runs `werkmeister connect` in a terminal named for it", async () => {
    process.env.WERKMEISTER_BIN = fixture("unused").bin;

    await vscode.commands.executeCommand("sandbox.connect");
    assert.deepEqual(
      vscode.window.terminals.map((t) => t.name),
      ["werkmeister connect"],
    );
  });

  // From ~ the wizard's feature and task defaults were the username (SW-51).
  test("New Workspace runs the wizard from the workspaces root, creating it", async () => {
    process.env.WERKMEISTER_BIN = fixture("unused").bin;
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-vsce-")), "workspaces");
    // The YAML outranks the env var, so point it at nothing.
    process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";
    process.env.WERKMEISTER_WORKSPACES_ROOT = root;

    await vscode.commands.executeCommand("sandbox.newWorkspace");
    assert.deepEqual(
      vscode.window.terminals.map((t) => [t.name, t.creationOptions.cwd]),
      [["werkmeister workspace", root]],
    );
    assert.ok(fs.statSync(root).isDirectory());
  });

  // sandbox.configure is a passthrough to a built-in, so what can break is the
  // passthrough: a renamed built-in or a typo'd id, which registration alone
  // would not catch. The `sandbox.` filter it passes is not readable back
  // through the API — checklist 10 still eyeballs that half.
  test("Configure opens the settings editor", async () => {
    await vscode.commands.executeCommand("sandbox.configure");

    const opened = await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab);
    assert.equal(opened?.label, "Settings");

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});

/** Poll `read` until it returns something truthy; the editor opens async. */
async function waitFor(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Write a `sandbox.*` setting and wait for the extension to have applied it to
 * `process.env`. The extension registered its `onDidChangeConfiguration`
 * listener at activation — before this one — so by the time this resolves,
 * `applySettingsToEnv()` has already run.
 */
async function setSetting(key, value) {
  const cfg = vscode.workspace.getConfiguration("sandbox");
  // An update that changes nothing fires no event; awaiting one would hang.
  if ((cfg.get(key) ?? "") === (value ?? "")) return;
  const applied = new Promise((resolve) => {
    const sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("sandbox")) return;
      sub.dispose();
      resolve();
    });
  });
  await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  await applied;
}

async function clearSettings() {
  await setSetting("root", undefined);
  await setSetting("binPath", undefined);
}

/**
 * The documented tier order: setting > SANDBOX_* env > ~/.sandbox/config.yaml.
 * The harness launches the host with WERKMEISTER_ROOT set and WERKMEISTER_BIN unset
 * (.vscode-test.mjs), standing in for the shell-launched editor this used to
 * take a quit-and-relaunch to check by hand (the retired checklist step 22).
 */
suite("Sandbox settings", () => {
  let inherited;

  suiteSetup(async () => {
    // Settings are written to the test instance's user-data dir and outlive the
    // run, so a crashed run can leave one behind.
    await clearSettings();
    inherited = process.env.WERKMEISTER_ROOT;
    assert.ok(inherited, "the host must launch with WERKMEISTER_ROOT set — see .vscode-test.mjs");
  });

  suiteTeardown(clearSettings);

  test("a setting overrides the inherited env, and clearing it restores it", async () => {
    await setSetting("root", "/tmp/sandbox-setting-wins");
    assert.equal(process.env.WERKMEISTER_ROOT, "/tmp/sandbox-setting-wins");

    // b175d8b: clearing used to delete the variable, silently dropping a
    // shell-launched window from the inherited checkout to whatever
    // ~/.sandbox/config.yaml named — the wrong-checkout bug.
    await setSetting("root", undefined);
    assert.equal(process.env.WERKMEISTER_ROOT, inherited);
  });

  test("clearing a setting with nothing inherited deletes the variable", async () => {
    await setSetting("binPath", "/tmp/sandbox-bin-wins");
    assert.equal(process.env.WERKMEISTER_BIN, "/tmp/sandbox-bin-wins");

    await setSetting("binPath", undefined);
    assert.equal(process.env.WERKMEISTER_BIN, undefined);
  });
});
