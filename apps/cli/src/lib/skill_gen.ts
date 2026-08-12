/**
 * JIT standards skill generation — docs/jit-context-system.md §5.1.
 *
 *     docs/standards/<domain>.md  →  sb-<domain>-standard SKILL.md content
 *
 * The standards doc is the single source of truth: the skill's description is
 * composed from the module frontmatter (summary + applies_to + phase → the
 * trigger gate), and the skill body is the doc body with relative links
 * rewritten so they resolve from any ephemeral workspace (§5.1 —
 * a workspace almost never has the sandbox repo checked out, so doc-relative
 * paths would dangle). Cross-module links become skill references; everything
 * else becomes the canonical GitHub URL.
 *
 * Rendering happens at the point of use: `lib/workspace_skills` projects
 * these into each workspace's `.claude/skills/` at init-workspace. There are
 * no committed generated copies (and hence no drift gate) anymore — the old
 * `sandbox standards build|check` flow and the plugin-shipped copies were
 * retired when delivery moved to workspace projection.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadGithubOrg } from "./global_config.js";
import {
  UNIVERSAL_STANDARDS,
  loadStandardsModules,
  parseFrontmatter,
} from "./standards.js";

export const GITHUB_REPO_BASE = "https://github.com/jbbz-sandbox/sandbox";
// Generated links target the default branch; there is no long-lived side
// branch to pin, so anything else would dangle.
export const GITHUB_BRANCH = "main";
// Relative links in a standards doc resolve against docs/standards/.
const _DOCS_STANDARDS_PREFIX = "docs/standards";
// Canonical-example pointers name service repos, which belong to whichever org
// runs this sandbox (`overrides.github_org`) — not to sandbox itself. HEAD
// links resolve to each repo's default branch without pinning one here.
function serviceRepoBase(): string {
  const org = loadGithubOrg();
  return org ? `https://github.com/${org}` : "";
}

const _GENERATED_HEADER = `<!--
  AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
  Source:    docs/standards/{source} in the sandbox repo (edit that file instead)
  Generator: sandbox init-workspace / sandbox skills sync
             (src/lib/workspace_skills.ts)
  Freshness: sandbox skills check
-->
`;

// Harness-7: a reloaded standard without the precedence framing measured 0/3
// applied against a conflicting task nudge — the skill body must carry its own
// precedence, not rely on sb-implement having delivered it pre-compaction.
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
  return `sb-${domain}-standard`;
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
  const rendered: Record<string, Record<string, string>> = {};
  for (const domain of Object.keys(modules).sort()) {
    const meta = modules[domain];
    const body = moduleBody(meta["path"]);
    const bundle: Record<string, string> = {
      "SKILL.md": renderSkill(domain, meta, body, knownDomains),
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
): string {
  const description = buildDescription(domain, meta);
  const source =
    path.basename(meta["path"]) === "STANDARD.md"
      ? `${domain}/STANDARD.md`
      : `${domain}.md`;
  const header = _GENERATED_HEADER.replace("{source}", source);
  body = rewriteLinks(body, knownDomains);
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
 * Measured (docs/experiments/context-management/results/): description length
 * costs nothing standing; wording drives trigger accuracy — so spell out the
 * phases and file patterns.
 */
function buildDescription(domain: string, meta: Record<string, any>): string {
  const summary = String(meta["summary"] || `${domain} coding standard.`).trim();
  // Python `or` semantics: an empty list falls back to the default; a scalar
  // string survives and `includes` does the same substring check as `in`.
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
  if (UNIVERSAL_STANDARDS.includes(domain)) {
    gate =
      `Use when ${verbClause} code of any kind — the universal base for ` +
      `every code edit, loaded by sb-implement at phase entry. ` +
      `Not during research/planning.`;
  } else {
    const appliesTo = meta["applies_to"];
    const globs = Array.isArray(appliesTo) ? appliesTo.join(", ") : "";
    gate =
      `Use when ${verbClause} ${domain} code` +
      (globs ? ` — files matching ${globs}` : "") +
      ". Not during research/planning, and not for edits outside this domain.";
  }
  return `Sandbox ${summary} ${gate}`;
}

/**
 * Make doc-relative links usable from any workspace (§5.1).
 *
 * A link to a sibling module (`comments.md`) becomes its skill reference;
 * any other relative link becomes the canonical GitHub URL. Absolute URLs
 * pass through untouched.
 */
function rewriteLinks(body: string, knownDomains: Set<string>): string {
  return body.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, text, target) => {
    if (/^[a-z]+:\/\//.test(target)) return match;
    if (target.startsWith("references/")) return match;
    const domainMatch = /^([a-z0-9-]+)\.md$/.exec(target);
    if (domainMatch && knownDomains.has(domainMatch[1])) {
      return `\`${skillNameFor(domainMatch[1])}\``;
    }
    let norm = path.posix.normalize(path.posix.join(_DOCS_STANDARDS_PREFIX, target));
    // posixpath.normpath strips a trailing slash; posix.normalize keeps it.
    if (norm.length > 1 && norm.endsWith("/")) norm = norm.slice(0, -1);
    const kind = target.endsWith("/") ? "tree" : "blob";
    return `[${text}](${GITHUB_REPO_BASE}/${kind}/${GITHUB_BRANCH}/${norm})`;
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
        `docs/standards/${domain}: STANDARD.md has an unfilled ` +
          `TODO(graduate) marker — run sb-author before committing`,
      );
    }
    const refsDir = meta["references_dir"];
    if (!refsDir) continue;
    for (const ref of globMd(refsDir)) {
      const refName = path.basename(ref);
      const refBody = moduleBody(ref);
      if (refBody.includes("TODO(graduate)")) {
        errors.push(
          `docs/standards/${domain}: references/${refName} has an ` +
            `unfilled TODO(graduate) marker — run sb-author before committing`,
        );
      }
      const canonical = String(parseFrontmatter(ref)["canonical"] ?? "");
      if (canonical === "TODO") {
        errors.push(
          `docs/standards/${domain}: references/${refName} has a ` +
            `placeholder canonical: TODO — fill in the real repo:path`,
        );
      }
      const link = `(references/${refName})`;
      if (!body.includes(link)) {
        errors.push(
          `docs/standards/${domain}: references/${refName} is not linked from STANDARD.md`,
        );
      } else if (
        refName.startsWith("ap-") &&
        !new RegExp(
          `^\\s*[-*] .*\\(references/${escapeRegex(refName)}\\)`,
          "m",
        ).test(body)
      ) {
        errors.push(
          `docs/standards/${domain}: references/${refName} needs ` +
            `an inline don't-line bullet linking to it`,
        );
      }
    }
  }
  return errors;
}
