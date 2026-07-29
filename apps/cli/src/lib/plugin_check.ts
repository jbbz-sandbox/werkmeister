/**
 * Plugin-version guard — context-management research doc §5 thread #5
 * (sharpened by the 2026-07-04 gap review).
 *
 * The whole read-side of the JIT context system rides on the `sandbox-tools`
 * plugin's skills surfacing in sessions, but a user-scope plugin install is a
 * *snapshot*: freshly generated skills in this repo reach no session until the
 * plugin is refreshed, and nothing detects the drift. This module compares the
 * installed plugin against the repo's `plugins/sandbox-tools/` at
 * `sandbox init-workspace` and returns loud warnings when the install lags.
 *
 * Warn-only by design: a stale (or absent) plugin degrades context quality but
 * must never block workspace initialisation, and any failure reading Claude's
 * plugin state is treated as "nothing to say", not an error.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getSandboxRoot } from "./config.js";

export const PLUGIN_NAME = "sandbox-tools";

export const REFRESH_HINT =
  "run `sandbox setup` to refresh it so sessions pick up the current " +
  "sandbox-* ops skills";

function defaultRepoPluginDir(): string {
  return path.join(getSandboxRoot(), "plugins", PLUGIN_NAME);
}

function defaultClaudePluginsDir(): string {
  return path.join(os.homedir(), ".claude", "plugins");
}

/** The version in the repo's plugin manifest, or null if unreadable. */
export function repoPluginVersion(repoPluginDir: string): string | null {
  const manifest = path.join(repoPluginDir, ".claude-plugin", "plugin.json");
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch {
    return null;
  }
  const version =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)["version"]
      : undefined;
  return version ? String(version) : null;
}

/**
 * The `plugins` mapping from installed_plugins.json, or null when the
 * registry is missing/unreadable/malformed (distinct from "no plugins").
 */
function loadRegistry(claudePluginsDir: string): Record<string, unknown> | null {
  const registry = path.join(claudePluginsDir, "installed_plugins.json");
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(registry, "utf8"));
  } catch {
    return null;
  }
  const plugins =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)["plugins"]
      : undefined;
  return typeof plugins === "object" && plugins !== null && !Array.isArray(plugins)
    ? (plugins as Record<string, unknown>)
    : null;
}

/**
 * Locate the installed sandbox-tools plugin via installed_plugins.json.
 *
 * Returns `[version, installPath]`, or `[null, null]` when the plugin
 * is not installed or the registry is unreadable (callers that need the
 * distinction use `loadRegistry` directly).
 */
export function installedPlugin(claudePluginsDir: string): [string | null, string | null] {
  const plugins = loadRegistry(claudePluginsDir);
  if (plugins === null) {
    return [null, null];
  }
  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith(`${PLUGIN_NAME}@`) || !Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const installPath = (entry as Record<string, unknown>)["installPath"];
      if (installPath) {
        const version = (entry as Record<string, unknown>)["version"];
        return [version ? String(version) : null, String(installPath)];
      }
    }
  }
  return [null, null];
}

/** Map skill name → SKILL.md content for every skill under *skillsDir*. */
function skillBodies(skillsDir: string): Map<string, string> {
  const bodies = new Map<string, string>();
  let isDir = false;
  try {
    isDir = fs.statSync(skillsDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return bodies;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return bodies;
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of names) {
    try {
      bodies.set(name, fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8"));
    } catch {
      continue;
    }
  }
  return bodies;
}

/**
 * Human-readable differences between the repo's skills and the install's.
 *
 * Three kinds: skills the install is missing, skills whose content is stale,
 * and orphaned skills the repo no longer carries.
 */
export function skillDrift(repoSkillsDir: string, installedSkillsDir: string): string[] {
  const repo = skillBodies(repoSkillsDir);
  const installed = skillBodies(installedSkillsDir);
  const drift: string[] = [];
  const missing = [...repo.keys()].filter((n) => !installed.has(n)).sort();
  const stale = [...repo.keys()]
    .filter((n) => installed.has(n) && repo.get(n) !== installed.get(n))
    .sort();
  const orphaned = [...installed.keys()].filter((n) => !repo.has(n)).sort();
  if (missing.length) {
    drift.push(`missing skills: ${missing.join(", ")}`);
  }
  if (stale.length) {
    drift.push(`stale skills: ${stale.join(", ")}`);
  }
  if (orphaned.length) {
    drift.push(`orphaned skills (removed from the repo): ${orphaned.join(", ")}`);
  }
  return drift;
}

/**
 * Warnings to surface at init-workspace when the plugin install lags.
 *
 * Empty list means the install matches the repo — or the state needed to
 * tell is unavailable (no repo plugin dir, unreadable registry), in which
 * case silence beats a false alarm on every init.
 */
export function pluginDriftWarnings(
  repoPluginDir?: string | null,
  claudePluginsDir?: string | null,
): string[] {
  if (repoPluginDir == null) {
    repoPluginDir = defaultRepoPluginDir();
  }
  if (claudePluginsDir == null) {
    claudePluginsDir = defaultClaudePluginsDir();
  }

  let repoSkillsIsDir = false;
  try {
    repoSkillsIsDir = fs.statSync(path.join(repoPluginDir, "skills")).isDirectory();
  } catch {
    repoSkillsIsDir = false;
  }
  if (!repoSkillsIsDir) {
    return []; // repo checkout has no plugin to compare against
  }

  if (loadRegistry(claudePluginsDir) === null) {
    return []; // no readable Claude plugin state on this machine — nothing to check
  }

  const [installedVersion, installPath] = installedPlugin(claudePluginsDir);
  if (installPath === null) {
    return [
      `${PLUGIN_NAME} plugin is not installed — the sandbox-* ops skills ` +
        `(sandbox-diagnose, sandbox-status, sandbox-workspace, …) will not ` +
        `surface in Claude Code sessions. Run \`sandbox setup\` to install ` +
        `it (or use /plugin in Claude Code). The sb-* skills are ` +
        `unaffected — they are projected into each workspace by ` +
        `init-workspace.`,
    ];
  }

  const drift = skillDrift(path.join(repoPluginDir, "skills"), path.join(installPath, "skills"));
  if (!drift.length) {
    return [];
  }

  const repoVersion = repoPluginVersion(repoPluginDir);
  let lag: string;
  if (repoVersion && installedVersion && repoVersion !== installedVersion) {
    lag = `installed ${PLUGIN_NAME} is v${installedVersion} but the repo is v${repoVersion}`;
  } else {
    lag = `installed ${PLUGIN_NAME} (v${installedVersion || "unknown"}) lags the repo`;
  }
  return [`${lag}: ${drift.join("; ")} — ${REFRESH_HINT}.`];
}
