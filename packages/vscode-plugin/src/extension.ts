import * as vscode from "vscode";
import { SandboxTreeProvider } from "./tree.js";
import { disposeTerminals } from "./terminal.js";
import { registerCommands, disposeOutputChannel } from "./commands.js";

/**
 * The SANDBOX_* values this process inherited, captured before any setting is
 * applied. Clearing a setting must restore these, not delete them: the
 * documented tier order is setting > env > ~/.sandbox/config.yaml, and a
 * shell-launched VS Code legitimately carries env from ~/.sandbox/env.sh.
 */
const INHERITED_ENV = {
  SANDBOX_BIN: process.env.SANDBOX_BIN,
  SANDBOX_ROOT: process.env.SANDBOX_ROOT,
} as const;

/**
 * Copy the extension's settings into process.env before any sandbox-core call.
 *
 * Tier order is: VS Code setting > SANDBOX_* env > ~/.sandbox/config.yaml. A
 * GUI-launched VS Code inherits no SANDBOX_* vars (~/.zshenv is never
 * sourced), so these settings are the escape hatch for a non-standard layout.
 * But a shell-launched `code .` DOES inherit them, and clearing the setting
 * back to its default (blank) must restore what was inherited rather than
 * delete it — deleting would drop tier 2 straight to tier 3 (or the
 * globally-linked ~/.local/bin/sandbox symlink), the wrong-checkout bug
 * fixed in b175d8b.
 */
export function applySettingsToEnv(): void {
  const cfg = vscode.workspace.getConfiguration("sandbox");
  for (const [key, envVar] of [
    ["binPath", "SANDBOX_BIN"],
    ["root", "SANDBOX_ROOT"],
  ] as const) {
    const value = cfg.get<string>(key, "").trim();
    if (value) {
      process.env[envVar] = value;
    } else if (INHERITED_ENV[envVar] !== undefined) {
      process.env[envVar] = INHERITED_ENV[envVar];
    } else {
      delete process.env[envVar];
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  applySettingsToEnv();

  const provider = new SandboxTreeProvider();
  const view = vscode.window.createTreeView("sandboxWorkspaces", { treeDataProvider: provider });

  context.subscriptions.push(
    view,
    provider.bind(view),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("sandbox")) return;
      applySettingsToEnv();
      provider.refresh();
    }),
    ...registerCommands(provider),
  );
}

export function deactivate(): void {
  disposeTerminals();
  disposeOutputChannel();
}
