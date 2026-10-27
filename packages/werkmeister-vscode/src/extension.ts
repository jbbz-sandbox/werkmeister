import * as vscode from "vscode";
import { disposeOutputChannel, registerCommands } from "./commands.js";
import { disposeLogTerminals } from "./logs.js";
import { disposeTerminals } from "./terminal.js";
import { SandboxTreeProvider } from "./tree.js";

/**
 * The WERKMEISTER_* values this process inherited, captured before any setting is
 * applied. A non-blank setting overrides them; an inherited value is never touched,
 * so it stays the fallback. Clearing a setting must restore these, not delete them: the
 * documented tier order is setting > env > ~/.werkmeister/config.yaml, and a
 * shell-launched VS Code legitimately carries env from ~/.werkmeister/env.sh.
 */
const INHERITED_ENV = {
  WERKMEISTER_BIN: process.env.WERKMEISTER_BIN,
  WERKMEISTER_ROOT: process.env.WERKMEISTER_ROOT,
} as const;

/**
 * Copy the extension's settings into process.env before any werkmeister-core call.
 *
 * Tier order is: VS Code setting > WERKMEISTER_* env > ~/.werkmeister/config.yaml. A
 * GUI-launched VS Code inherits no WERKMEISTER_* vars (~/.zshenv is never
 * sourced), so these settings are the escape hatch for a non-standard layout.
 * But a shell-launched `code .` DOES inherit them, and clearing the setting
 * back to its default (blank) must restore what was inherited rather than
 * delete it — deleting would drop tier 2 straight to tier 3 (or the
 * globally-linked ~/.local/bin/werkmeister symlink), the wrong-checkout bug
 * fixed in b175d8b.
 */
export function applySettingsToEnv(): void {
  const cfg = vscode.workspace.getConfiguration("sandbox");
  for (const [key, envVar] of [
    ["binPath", "WERKMEISTER_BIN"],
    ["root", "WERKMEISTER_ROOT"],
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
  disposeLogTerminals();
  disposeOutputChannel();
}
