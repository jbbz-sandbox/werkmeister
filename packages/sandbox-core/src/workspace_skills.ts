/**
 * Workspace skill projection — docs/jit-context-system.md §5.
 *
 * The sb-* skills are projected into each workspace's `.claude/skills/`
 * at init-workspace, exactly like the generated agents — NOT shipped through
 * the user-scope werkmeister plugin. Projection scopes them to the sessions
 * they apply to and kills the plugin-refresh lag for the volatile skills:
 * init always renders fresh from this repo, so a standards edit reaches new
 * workspaces with no marketplace/install step. The plugin keeps only the
 * globally useful ops skills.
 *
 * Two source kinds, one output:
 * - the five sb-*-standard skills render on the fly from docs/standards/*.md
 *   (werkmeister-core/skill_gen — no committed generated copies anywhere anymore) as
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

import { forDotDir, infraRoot } from "./config.js";
import { loadManifest } from "./gate.js";
import { info, success } from "./reporter.js";
import { generateSkills, skillNameFor, validateModuleReferences } from "./skill_gen.js";
import type { StandardsManifest } from "./standards.js";
import {
  buildStandardsManifest,
  loadStandardsModules,
  repoDirs,
  resolveActiveStandards,
  writeStandardsManifest,
} from "./standards.js";
import { loadConfigFile, loadSandboxServiceConfigs, planFor } from "./workspace_prompts.js";

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
  active?: string[] | null,
): Record<string, Record<string, string>> {
  const skills: Record<string, Record<string, string>> = {};
  try {
    // Scoped to the workspace's active standards when the caller resolved
    // them: a skill that is not there cannot be loaded, which beats a "do not
    // load" line in the routing table (jit-context-system.md §2). Null means
    // no filter — the fallback when nothing about the workspace is known.
    const keep = active ? new Set(active.map(skillNameFor)) : null;
    for (const [name, bundle] of Object.entries(generateSkills(standardsDir))) {
      if (!keep || keep.has(name)) skills[name] = bundle;
    }
  } catch {
    // OSError equivalent — a stripped checkout yields no standards skills.
  }
  const source = entrySkillsDir ?? skillsSourceDir();
  if (isDir(source)) {
    const names = fs
      .readdirSync(source, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(source, e.name, "SKILL.md")))
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
  active?: string[] | null,
): string[] {
  const rendered = renderWorkspaceSkills(standardsDir, entrySkillsDir, active);
  const target = workspaceSkillsDir(workspaceRoot);
  const written: string[] = [];
  for (const name of Object.keys(rendered).sort()) {
    const bundle = rendered[name];
    for (const relpath of Object.keys(bundle).sort()) {
      const content = forDotDir(bundle[relpath], workspaceRoot);
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
  active?: string[] | null,
): string[] {
  const rendered = renderWorkspaceSkills(standardsDir, entrySkillsDir, active);
  const target = workspaceSkillsDir(workspaceRoot);
  const errors: string[] = [];

  for (const name of Object.keys(rendered).sort()) {
    const bundle = rendered[name];
    for (const relpath of Object.keys(bundle).sort()) {
      const content = forDotDir(bundle[relpath], workspaceRoot);
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
 * The workspace's active standard keys, re-resolved from what it persisted
 * (repo worktrees on disk + `.sandbox/workspace.yml`) — `sandbox skills
 * sync`/`check` run standalone, without init's original CLI args. Null when
 * no standards modules exist (nothing to scope or check).
 */
export function resolveWorkspaceActive(
  workspace: string,
): { active: string[]; modules: Record<string, Record<string, any>>; workType: string } | null {
  const modules = loadStandardsModules();
  if (!Object.keys(modules).length) {
    return null;
  }
  const repoNames = repoDirs(workspace).map((p) => path.basename(p));
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const workspaceConfig = loadConfigFile(workspace, null);
  let localServices = (workspaceConfig["services"] || []) as string[] | string;
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
  return { active, modules, workType: String(workspaceConfig["work_type"] ?? "") };
}

/**
 * Recompute the gate manifest for an already-initialized workspace. The phase
 * gate is recompiled from the work type only when the on-disk manifest already
 * carries one: init-workspace is the only place that introduces the gate (its
 * CLAUDE.md explains it), so the every-session `skills check || sync` never
 * adds one mid-work to a workspace created before gates existed.
 */
export function resolveWorkspaceManifest(
  workspace: string,
  resolved: ReturnType<typeof resolveWorkspaceActive> = resolveWorkspaceActive(workspace),
): StandardsManifest | null {
  if (resolved === null) {
    return null;
  }
  const gated = (loadManifest(workspace)?.["phase_gate"] ?? null) !== null;
  const gate = gated ? planFor(resolved.workType).gate : null;
  return buildStandardsManifest(resolved.active, resolved.modules, gate);
}

export interface SkillsCheck {
  /** Bad module references in this repo's standards — a source problem, not the workspace's. */
  authoring: string[];
  /** Missing / stale / orphaned projected skills in the workspace. */
  drift: string[];
}

/**
 * The two drift sources that read only this repo and the workspace's
 * `.claude/skills/`. `active` scopes the expected projection; pass the result
 * of {@link resolveWorkspaceActive} (its `.active`, or null).
 */
export function checkSkills(workspace: string, active: string[] | null = null): SkillsCheck {
  return {
    authoring: validateModuleReferences(),
    drift: checkWorkspaceSkills(workspace, null, null, active),
  };
}

/**
 * The third drift source: `.sandbox/standards.json` no longer matching a fresh
 * resolution. Returns the drift entry, or null when current (or when the repo
 * has no standards modules to resolve). Takes the caller's resolution so the
 * workspace config is read — and logged — once per command.
 */
export function checkStandardsManifest(
  workspace: string,
  resolved: ReturnType<typeof resolveWorkspaceActive> = resolveWorkspaceActive(workspace),
): string | null {
  const manifest = resolveWorkspaceManifest(workspace, resolved);
  if (manifest === null) {
    return null;
  }
  const onDisk = loadManifest(workspace);
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
  const resolved = resolveWorkspaceActive(workspace);
  const written = writeWorkspaceSkills(workspace, null, null, resolved?.active ?? null);
  for (const p of written) {
    info(`wrote ${p}`);
  }
  success(`Projected ${written.length} sb-* skill(s) into ${workspaceSkillsDir(workspace)}`);

  const manifest = resolveWorkspaceManifest(workspace, resolved);
  if (manifest === null) {
    return { written, manifestPath: null };
  }
  const manifestPath = writeStandardsManifest(workspace, manifest);
  info(`wrote ${manifestPath}`);
  return { written, manifestPath };
}
