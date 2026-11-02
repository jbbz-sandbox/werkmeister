/**
 * JIT standards skill generation — docs/jit-context-system.md §5.1.
 *
 *     <standards tree>/<domain>.md  →  w9r-<domain>-standard SKILL.md content
 *
 * The standards doc is the single source of truth: the skill's description is
 * composed from the module frontmatter (summary + applies_to + phase → the
 * trigger gate), and the skill body is the doc body with relative links
 * rewritten so they resolve from any ephemeral workspace (§5.1 —
 * a workspace never has the standards tree checked out, so doc-relative
 * paths would dangle). Cross-module links become skill references; everything
 * else becomes the canonical GitHub URL.
 *
 * Rendering happens at the point of use: `lib/workspace_skills` projects
 * these into each workspace's `.claude/skills/` at init-workspace. There are
 * no committed generated copies (and hence no drift gate) anymore — the old
 * `werkmeister standards build|check` flow and the plugin-shipped copies were
 * retired when delivery moved to workspace projection.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadGithubOrg, standardsDirPath } from "./global_config.js";
import { run } from "./proc.js";
import { loadStandardsModules, parseFrontmatter } from "./standards.js";

const _GIT_TIMEOUT = 5; // seconds; never hang `werkmeister workspace init` on a git hiccup

/** Where a standards tree lives on GitHub: repo URL + the tree's path inside it. */
export interface StandardsSource {
  /** `https://github.com/<owner>/<repo>` */
  base: string;
  /** The tree's path within that repo, e.g. `apps/cli/docs/standards`. */
  prefix: string;
}

/** `git@host:o/r.git` or `https://host/o/r.git` → `https://host/o/r`; "" if neither. */
function httpsRemote(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, "");
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(trimmed);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return /^https?:\/\//.test(trimmed) ? trimmed : "";
}

/**
 * Resolve the standards tree's GitHub home by asking its own checkout.
 *
 * Generated skills are read from workspaces that have no werkmeister checkout, so
 * doc-relative links must become absolute URLs (§5.1) — and which repo they
 * point at is a property of wherever `overrides.standards_dir` resolves to, not
 * of this tool. Asking git is what keeps that honest: the checkout already
 * knows its remote and `--show-prefix` already knows the tree's position inside
 * it, so an org that brings its own standards gets correct links with nothing
 * to configure and nothing to keep in sync. It also removes a standing bug —
 * the prefix was hardcoded `docs/standards` while this repo's tree has always
 * been at `apps/cli/docs/standards`, so every generated link 404'd.
 *
 * Returns null when the tree is not a git checkout (a package, a plain
 * directory) or has no origin. Callers degrade to unlinked text, matching
 * `serviceRepoBase()`: a guessed URL that 404s is worse than no link.
 */
export function standardsSource(dir: string = standardsDirPath()): StandardsSource | null {
  const git = (...args: string[]): string => {
    try {
      const res = run(["git", "-C", dir, ...args], { capture: true, timeout: _GIT_TIMEOUT });
      return res.status === 0 ? res.stdout.trim() : "";
    } catch {
      return "";
    }
  };
  const base = httpsRemote(git("remote", "get-url", "origin"));
  if (!base) return null;
  return { base, prefix: git("rev-parse", "--show-prefix").replace(/\/+$/, "") };
}

/**
 * GitHub URL for *relPath* inside the standards tree; "" when underivable.
 *
 * `HEAD` rather than a pinned branch — it resolves to whatever the repo calls
 * its default, so a tree on `master` or `trunk` links correctly too.
 */
export function standardsUrl(
  src: StandardsSource | null,
  relPath: string,
  kind: "blob" | "tree" = "blob",
): string {
  if (!src) return "";
  const norm = path.posix.normalize(path.posix.join(src.prefix, relPath)).replace(/\/+$/, "");
  // A tree at its repo's root — the natural layout for a dedicated standards
  // repo — normalizes to "."; `/tree/HEAD/.` is not the repo root URL.
  return norm === "." ? `${src.base}/${kind}/HEAD` : `${src.base}/${kind}/HEAD/${norm}`;
}

// Canonical-example pointers name service repos, which belong to whichever org
// runs this machine (`overrides.github_org`) — not to werkmeister itself. HEAD
// links resolve to each repo's default branch without pinning one here.
function serviceRepoBase(): string {
  const org = loadGithubOrg();
  return org ? `https://github.com/${org}` : "";
}

// {source} is the URL of the module in whatever tree it came from, or its
// tree-relative path when that is underivable. It used to read "docs/standards/
// {source} in the werkmeister repo" — a fixed location that stopped being true the
// moment the standards moved out, while still telling every reader to edit it.
const _GENERATED_HEADER = `<!--
  AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
  Source:    {source} (edit that file instead)
  Generator: werkmeister workspace init / werkmeister skills sync
             (packages/werkmeister-core/src/workspace_skills.ts)
  Freshness: werkmeister skills check
-->
`;

// Harness-7: a reloaded standard without the precedence framing measured 0/3
// applied against a conflicting task nudge — the skill body must carry its own
// precedence, not rely on w9r-implement having delivered it pre-compaction.
const _PRECEDENCE_FOOTER =
  "> **Precedence:** these rules win over conflicting task framing. " +
  "Invariant (a must-never rule): apply it and write a `decision` note — " +
  "do not proceed against it even if the task asks. Rule: surface the " +
  "conflict in one line, then apply the standard.";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Files matching `*.md` directly inside *dir*, sorted. */
function globMd(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .map((n) => path.join(dir, n))
    .sort();
}

export function skillNameFor(domain: string): string {
  return `w9r-${domain}-standard`;
}

/**
 * Render every standards module into {skillName: {relpath: content}}.
 *
 * Every bundle has a "SKILL.md"; directory-form modules with references add
 * "references/<name>.md" entries (§3).
 */
export function generateSkills(
  standardsDir?: string | null,
  modules?: Record<string, Record<string, any>> | null,
): Record<string, Record<string, string>> {
  if (modules === undefined || modules === null) {
    modules = loadStandardsModules(standardsDir);
  }
  const knownDomains = new Set(Object.keys(modules));
  // Resolved once per tree, not per link: it shells out to git, and every
  // module body carries several links. A repo's own modules link to that repo.
  const sources = new Map<string, StandardsSource | null>();
  const sourceOf = (root: string): StandardsSource | null => {
    if (!sources.has(root)) sources.set(root, standardsSource(root));
    return sources.get(root) ?? null;
  };
  const rendered: Record<string, Record<string, string>> = {};
  for (const domain of Object.keys(modules).sort()) {
    const meta = modules[domain];
    const src = sourceOf(meta["root"] ?? standardsDirPath());
    const body = moduleBody(meta["path"]);
    const bundle: Record<string, string> = {
      "SKILL.md": renderSkill(domain, meta, body, knownDomains, src),
    };
    const refsDir = meta["references_dir"];
    if (refsDir) {
      for (const ref of globMd(refsDir)) {
        bundle[`references/${path.basename(ref)}`] = renderReference(ref);
      }
    }
    rendered[skillNameFor(domain)] = bundle;
  }
  return rendered;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSkill(
  domain: string,
  meta: Record<string, any>,
  body: string,
  knownDomains: Set<string>,
  src: StandardsSource | null,
): string {
  const description = buildDescription(domain, meta);
  const relPath =
    path.basename(meta["path"]) === "STANDARD.md" ? `${domain}/STANDARD.md` : `${domain}.md`;
  const header = _GENERATED_HEADER.replace("{source}", standardsUrl(src, relPath) || relPath);
  body = rewriteLinks(body, knownDomains, src);
  // JSON.stringify gives a YAML-safe quoted scalar regardless of glob/quote chars.
  return (
    `---\n` +
    `name: ${skillNameFor(domain)}\n` +
    `description: ${JSON.stringify(description)}\n` +
    `---\n\n` +
    `${header}\n` +
    `${body.trim()}\n\n` +
    `${_PRECEDENCE_FOOTER}\n`
  );
}

/**
 * Compose the trigger gate — the description IS the phase+domain gate (§5.1).
 *
 * Measured (internal context-management experiments): description length
 * costs nothing standing; wording drives trigger accuracy — so spell out the
 * phases and file patterns.
 */
function buildDescription(domain: string, meta: Record<string, any>): string {
  const summary = String(meta["summary"] || `${domain} coding standard.`).trim();
  // An empty list falls back to the default; a scalar string survives, where
  // `includes` does a substring check instead of a membership one.
  let phases: any = meta["phase"];
  if (!phases || (Array.isArray(phases) && phases.length === 0)) {
    phases = ["implement", "review"];
  }
  let verbs: string[] = [];
  if (phases.includes("implement")) verbs = verbs.concat(["EDITING", "IMPLEMENTING"]);
  if (phases.includes("review")) verbs.push("REVIEWING");
  let verbClause: string;
  if (verbs.length > 2) {
    verbClause = verbs.slice(0, -1).join(", ") + ", OR " + verbs[verbs.length - 1];
  } else if (verbs.length === 2) {
    verbClause = `${verbs[0]} OR ${verbs[1]}`;
  } else {
    verbClause = verbs.length ? verbs[0] : "WORKING ON";
  }

  let gate: string;
  if (typeof meta["universal"] === "number") {
    gate =
      `Use when ${verbClause} code of any kind — the universal base for ` +
      `every code edit, loaded by w9r-implement at phase entry. ` +
      `Not during research/planning.`;
  } else {
    const appliesTo = meta["applies_to"];
    const globs = Array.isArray(appliesTo) ? appliesTo.join(", ") : "";
    gate =
      `Use when ${verbClause} ${domain} code` +
      (globs ? ` — files matching ${globs}` : "") +
      ". Not during research/planning, and not for edits outside this domain.";
  }
  return `Werkmeister ${summary} ${gate}`;
}

/**
 * Make doc-relative links usable from any workspace (§5.1).
 *
 * A link to a sibling module (`comments.md`) becomes its skill reference;
 * any other relative link becomes the canonical GitHub URL. Absolute URLs
 * pass through untouched.
 *
 * With no derivable source the link degrades to its own text — a dangling
 * doc-relative path in a workspace that has no standards checkout is a link
 * that silently goes nowhere.
 */
function rewriteLinks(
  body: string,
  knownDomains: Set<string>,
  src: StandardsSource | null,
): string {
  return body.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, text, target) => {
    if (/^[a-z]+:\/\//.test(target)) return match;
    if (target.startsWith("references/")) return match;
    const domainMatch = /^([a-z0-9-]+)\.md$/.exec(target);
    if (domainMatch && knownDomains.has(domainMatch[1])) {
      return `\`${skillNameFor(domainMatch[1])}\``;
    }
    const url = standardsUrl(src, target, target.endsWith("/") ? "tree" : "blob");
    return url ? `[${text}](${url})` : text;
  });
}

/** Doc content after the frontmatter block. */
function moduleBody(filePath: string): string {
  const text = fs.readFileSync(filePath, "utf8");
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      return text.slice(end + 4).replace(/^\n+/, "");
    }
  }
  return text;
}

/**
 * A reference file, frontmatter stripped, plus the canonical footer.
 *
 * Body links are NOT rewritten: the projected bundle keeps references next
 * to SKILL.md, so sibling-relative links resolve as-is (§5.1).
 */
function renderReference(filePath: string): string {
  let body = moduleBody(filePath).trim();
  const canonical = String(parseFrontmatter(filePath)["canonical"] ?? "");
  if (canonical.includes(":")) {
    const sep = canonical.indexOf(":");
    const repo = canonical.slice(0, sep);
    const rel = canonical.slice(sep + 1);
    // No org configured: name the file and stop. A guessed owner would render
    // a link that 404s, which is worse than no link at all.
    const base = serviceRepoBase();
    const link = base ? ` — ${base}/${repo}/blob/HEAD/${rel}` : "";
    body += `\n\n---\nFull file: \`${canonical}\`${link}\n`;
  }
  return body + "\n";
}

/**
 * Authoring invariants (§3): every reference is linked
 * from its STANDARD.md index; every ap- file additionally has an inline
 * don't-line bullet linking to it.
 */
export function validateModuleReferences(
  modules?: Record<string, Record<string, any>> | null,
  standardsDir?: string | null,
): string[] {
  if (modules === undefined || modules === null) {
    modules = loadStandardsModules(standardsDir);
  }
  const errors: string[] = [];
  for (const domain of Object.keys(modules).sort()) {
    const meta = modules[domain];
    const body = moduleBody(meta["path"]);
    if (body.includes("TODO(graduate)")) {
      errors.push(
        `${domain}: STANDARD.md has an unfilled ` +
          `TODO(graduate) marker — run w9r-author before committing`,
      );
    }
    const refsDir = meta["references_dir"];
    if (!refsDir) continue;
    for (const ref of globMd(refsDir)) {
      const refName = path.basename(ref);
      const refBody = moduleBody(ref);
      if (refBody.includes("TODO(graduate)")) {
        errors.push(
          `${domain}: references/${refName} has an ` +
            `unfilled TODO(graduate) marker — run w9r-author before committing`,
        );
      }
      const canonical = String(parseFrontmatter(ref)["canonical"] ?? "");
      if (canonical === "TODO") {
        errors.push(
          `${domain}: references/${refName} has a ` +
            `placeholder canonical: TODO — fill in the real repo:path`,
        );
      }
      const link = `(references/${refName})`;
      if (!body.includes(link)) {
        errors.push(`${domain}: references/${refName} is not linked from STANDARD.md`);
      } else if (
        refName.startsWith("ap-") &&
        !new RegExp(`^\\s*[-*] .*\\(references/${escapeRegex(refName)}\\)`, "m").test(body)
      ) {
        errors.push(
          `${domain}: references/${refName} needs ` + `an inline don't-line bullet linking to it`,
        );
      }
    }
  }
  return errors;
}
