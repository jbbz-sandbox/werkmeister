/**
 * Workspace skill projection — docs/jit-context-system.md §5.
 *
 * The sb-* skills are projected into each workspace's `.claude/skills/`
 * at init-workspace, exactly like the generated agents — NOT shipped through
 * the user-scope sandbox-tools plugin. Projection scopes them to the sessions
 * they apply to and kills the plugin-refresh lag for the volatile skills:
 * init always renders fresh from this repo, so a standards edit reaches new
 * workspaces with no marketplace/install step. The plugin keeps only the
 * globally useful sandbox-* ops skills.
 *
 * Two source kinds, one output:
 * - the five sb-*-standard skills render on the fly from docs/standards/*.md
 *   (sandbox-core/skill_gen — no committed generated copies anywhere anymore) as
 *   file bundles: SKILL.md plus, for directory-form modules, references/*.md;
 * - the seven hand-authored entry skills (sb-implement, sb-research, sb-test,
 *   sb-handoff, sb-review, sb-pr, sb-author) are read verbatim from
 *   infra/skills/ as one-file {"SKILL.md": content} bundles.
 *
 * Mid-feature staleness is handled by {@link checkSkills} / {@link syncSkills}
 * below (`sandbox skills check|sync`). Sessions must start at the workspace root —
 * project skills (like the workspace hooks) resolve from the session's
 * project directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { infraRoot } from "./config.js";
import { info, success } from "./reporter.js";
import { generateSkills, validateModuleReferences } from "./skill_gen.js";
import {
  buildStandardsManifest,
  loadStandardsModules,
  repoDirs,
  resolveActiveStandards,
  writeStandardsManifest,
} from "./standards.js";
import { loadConfigFile, loadSandboxServiceConfigs } from "./workspace_prompts.js";

// sb-*-prefixed skill dirs under a workspace's .claude/skills/ are managed by
// this module: written on init/sync, pruned when their source disappears.
const _MANAGED_PREFIX = "sb-";

/** The hand-authored entry-skill sources: infra/skills/<name>/SKILL.md. */
export function skillsSourceDir(): string {
  return path.join(infraRoot(), "skills");
}

function isDir(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

/** All *.md files under *dir*, recursively, sorted by full path. */
function rglobMd(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Render every sb-* skill as {name: {relative-path: content}}.
 *
 * Standards skills are generated from docs/standards/; entry skills are
 * read from infra/skills/. Either source being absent (e.g. running
 * against a stripped checkout) just yields fewer skills — projection is
 * best-effort, never a hard requirement of init.
 */
export function renderWorkspaceSkills(
  standardsDir?: string | null,
  entrySkillsDir?: string | null,
): Record<string, Record<string, string>> {
  const skills: Record<string, Record<string, string>> = {};
  try {
    Object.assign(skills, generateSkills(standardsDir));
  } catch {
    // OSError equivalent — a stripped checkout yields no standards skills.
  }
  const source = entrySkillsDir ?? skillsSourceDir();
  if (isDir(source)) {
    const names = fs
      .readdirSync(source, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && fs.existsSync(path.join(source, e.name, "SKILL.md")),
      )
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      try {
        skills[name] = {
          "SKILL.md": fs.readFileSync(path.join(source, name, "SKILL.md"), "utf8"),
        };
      } catch {
        continue;
      }
    }
  }
  return skills;
}

export function workspaceSkillsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "skills");
}

/**
 * Project the sb-* skills into the workspace; returns paths written.
 *
 * Prunes managed (sb-*) skill dirs whose source no longer exists; anything
 * without the managed prefix is the user's and is never touched.
 */
export function writeWorkspaceSkills(
  workspaceRoot: string,
  standardsDir?: string | null,
  entrySkillsDir?: string | null,
): string[] {
  const rendered = renderWorkspaceSkills(standardsDir, entrySkillsDir);
  const target = workspaceSkillsDir(workspaceRoot);
  const written: string[] = [];
  for (const name of Object.keys(rendered).sort()) {
    const bundle = rendered[name];
    for (const relpath of Object.keys(bundle).sort()) {
      const content = bundle[relpath];
      const filePath = path.join(target, name, relpath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== content) {
        fs.writeFileSync(filePath, content);
      }
      written.push(filePath);
    }
  }

  if (isDir(target)) {
    for (const entryName of fs.readdirSync(target).sort()) {
      const entry = path.join(target, entryName);
      if (!(isDir(entry) && entryName.startsWith(_MANAGED_PREFIX))) continue;
      if (!(entryName in rendered)) {
        fs.rmSync(entry, { recursive: true, force: true });
        continue;
      }
      const bundle = rendered[entryName];
      for (const stray of rglobMd(entry)) {
        const rel = path.relative(entry, stray).split(path.sep).join("/");
        if (!(rel in bundle)) fs.unlinkSync(stray);
      }
      const refs = path.join(entry, "references");
      if (isDir(refs) && fs.readdirSync(refs).length === 0) {
        fs.rmdirSync(refs);
      }
    }
  }
  return written;
}

/**
 * Compare a workspace's projected skills against a fresh rendering.
 *
 * Returns human-readable drift strings (missing / stale / orphaned sb-*
 * skills); empty means the workspace is current.
 */
export function checkWorkspaceSkills(
  workspaceRoot: string,
  standardsDir?: string | null,
  entrySkillsDir?: string | null,
): string[] {
  const rendered = renderWorkspaceSkills(standardsDir, entrySkillsDir);
  const target = workspaceSkillsDir(workspaceRoot);
  const errors: string[] = [];

  for (const name of Object.keys(rendered).sort()) {
    const bundle = rendered[name];
    for (const relpath of Object.keys(bundle).sort()) {
      const content = bundle[relpath];
      const filePath = path.join(target, name, relpath);
      if (!(fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
        errors.push(`missing: ${name}/${relpath}`);
      } else if (fs.readFileSync(filePath, "utf8") !== content) {
        errors.push(`stale: ${name}/${relpath}`);
      }
    }
  }

  if (isDir(target)) {
    for (const entryName of fs.readdirSync(target).sort()) {
      const entry = path.join(target, entryName);
      if (!(isDir(entry) && entryName.startsWith(_MANAGED_PREFIX))) continue;
      if (!(entryName in rendered)) {
        errors.push(`orphaned: ${entryName}`);
        continue;
      }
      for (const stray of rglobMd(entry)) {
        const rel = path.relative(entry, stray).split(path.sep).join("/");
        if (!(rel in rendered[entryName])) {
          errors.push(`orphaned: ${entryName}/${rel}`);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The `sandbox skills check|sync` verbs
// ---------------------------------------------------------------------------

/** Recursively canonicalize for order-independent value comparison. */
export function canonical(value: unknown): unknown {
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
export function resolveWorkspaceManifest(workspace: string): Record<string, any> | null {
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

export interface SkillsCheck {
  /** Bad module references in this repo's standards — a source problem, not the workspace's. */
  authoring: string[];
  /** Missing / stale / orphaned projected skills in the workspace. */
  drift: string[];
}

/** The two drift sources that read only this repo and the workspace's `.claude/skills/`. */
export function checkSkills(workspace: string): SkillsCheck {
  return {
    authoring: validateModuleReferences(),
    drift: checkWorkspaceSkills(workspace),
  };
}

/**
 * The third drift source: `.sandbox/standards.json` no longer matching a fresh
 * resolution. Returns the drift entry, or null when current (or when the repo
 * has no standards modules to resolve).
 *
 * Kept out of {@link checkSkills} rather than folded into its `drift` because
 * resolving the manifest reads `.sandbox/workspace.yml`, which reports through
 * the reporter — folding it in would move that `[info]` line ahead of the drift
 * lines the caller prints, and the CLI's output is a fixed contract.
 */
export function checkStandardsManifest(workspace: string): string | null {
  const manifest = resolveWorkspaceManifest(workspace);
  if (manifest === null) {
    return null;
  }
  const manifestPath = path.join(workspace, ".sandbox", "standards.json");
  let onDisk: unknown = null;
  if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
    try {
      onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      onDisk = null;
    }
  }
  if (JSON.stringify(canonical(onDisk)) === JSON.stringify(canonical(manifest))) {
    return null;
  }
  return "stale: .sandbox/standards.json";
}

export interface SkillsSync {
  /** Every projected file, whether or not its content changed. */
  written: string[];
  /** Null when the repo has no standards modules, so no manifest was written. */
  manifestPath: string | null;
}

/** `sandbox skills sync`: reproject the skills and refresh the gate manifest. */
export function syncSkills(workspace: string): SkillsSync {
  const written = writeWorkspaceSkills(workspace);
  for (const p of written) {
    info(`wrote ${p}`);
  }
  success(`Projected ${written.length} sb-* skill(s) into ${workspaceSkillsDir(workspace)}`);

  const manifest = resolveWorkspaceManifest(workspace);
  if (manifest === null) {
    return { written, manifestPath: null };
  }
  const manifestPath = writeStandardsManifest(workspace, manifest);
  info(`wrote ${manifestPath}`);
  return { written, manifestPath };
}
