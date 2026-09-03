/**
 * sandbox skills <check|sync>
 *
 * Freshness control for the sb-* skills projected into a workspace's
 * `.claude/skills/` (docs/jit-context-system.md §5 — skills are projected at
 * init-workspace, not shipped via the plugin, so a workspace inited before a
 * standards edit lags until re-synced).
 *
 * check: compare the workspace's projected skills against a fresh rendering
 *       from this repo; exit 1 with a per-skill report when stale.
 * sync:  rewrite the projection (same writer init-workspace uses) and prune
 *       orphaned sb-* skills.
 *
 * Run from anywhere inside a workspace — the workspace root is resolved by
 * walking up to the nearest `.sandbox/` directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfigFile, loadSandboxServiceConfigs } from "sandbox-core/workspace_prompts";
import { findWorkspaceRoot } from "./notes.js";
import { Colors, error, info, success } from "../lib/config.js";
import { validateModuleReferences } from "sandbox-core/skill_gen";
import {
  buildStandardsManifest,
  loadStandardsModules,
  repoDirs,
  resolveActiveStandards,
  writeStandardsManifest,
} from "sandbox-core/standards";
import { checkWorkspaceSkills, writeWorkspaceSkills } from "sandbox-core/workspace_skills";

/** Recursively canonicalize for order-independent value comparison. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Recompute the gate manifest for an already-initialized workspace.
 *
 * Reconstructs init-workspace's resolution inputs from what the workspace
 * already persisted (repo worktrees on disk + `.sandbox/workspace.yml`) —
 * `sandbox skills sync`/`check` run standalone, without init's original
 * CLI args. Returns null when no standards modules exist (nothing to check).
 */
function resolveWorkspaceManifest(workspace: string): Record<string, any> | null {
  const modules = loadStandardsModules();
  if (!Object.keys(modules).length) {
    return null;
  }
  const repoNames = repoDirs(workspace).map((p) => path.basename(p));
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const workspaceConfig = loadConfigFile(workspace, null);
  let localServices = workspaceConfig["services"] || [];
  if (typeof localServices === "string") {
    localServices = localServices
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s);
  }
  const [active] = resolveActiveStandards(
    repoNames,
    servicesConfig,
    reposConfig,
    workspaceConfig,
    modules,
    localServices,
  );
  return buildStandardsManifest(active, modules);
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const workspace = findWorkspaceRoot(process.cwd());
  if (workspace === null) {
    error("Not inside a sandbox workspace (no .sandbox/ directory found above CWD).");
    process.exit(1);
  }

  if (args.action === "sync") {
    const written = writeWorkspaceSkills(workspace);
    for (const p of written) {
      info(`wrote ${p}`);
    }
    success(
      `Projected ${written.length} sb-* skill(s) into ${path.join(workspace, ".claude", "skills")}`,
    );

    const manifest = resolveWorkspaceManifest(workspace);
    if (manifest !== null) {
      const manifestPath = writeStandardsManifest(workspace, manifest);
      info(`wrote ${manifestPath}`);
    }
    return;
  }

  const authoring = validateModuleReferences();
  for (const entry of authoring) {
    console.log(`${Colors.RED}✗ ${entry}${Colors.RESET}`);
  }

  const drift = checkWorkspaceSkills(workspace);
  for (const entry of drift) {
    console.log(`${Colors.RED}✗ ${entry}${Colors.RESET}`);
  }

  const manifest = resolveWorkspaceManifest(workspace);
  if (manifest !== null) {
    const manifestPath = path.join(workspace, ".sandbox", "standards.json");
    let onDisk: unknown = null;
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      try {
        onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        onDisk = null;
      }
    }
    if (JSON.stringify(canonical(onDisk)) !== JSON.stringify(canonical(manifest))) {
      const entry = "stale: .sandbox/standards.json";
      console.log(`${Colors.RED}✗ ${entry}${Colors.RESET}`);
      drift.push(entry);
    }
  }

  if (drift.length) {
    console.log(
      `${Colors.YELLOW}Workspace skills lag the sandbox repo — run ` +
        "`sandbox skills sync` (or `sandbox init-workspace`) to refresh." +
        `${Colors.RESET}`,
    );
  }
  if (authoring.length || drift.length) {
    process.exit(1);
  }
  success("Workspace sb-* skills are current.");
}
