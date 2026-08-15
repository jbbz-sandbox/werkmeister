/**
 * JIT code-standards resolution — the repo-presence axis of the standards
 * system (docs/jit-context-system.md §4.1).
 *
 * Maps a workspace's repo composition to the set of applicable standards
 * modules:
 *
 *     docs/standards/<key>.md  (frontmatter: domain / applies_to / phase / summary)
 *         ▲ validated against
 *     services.yaml `archetype:` / legacy `standards:` per service
 *         ▼ normalized by lib/archetypes, union over the workspace's repos,
 *           ± workspace.yml `standards_override`
 *     "Standards routing" block in the workspace CLAUDE.md  (rendered by claude_md.ts)
 *
 * `comments` is the universal base: always active, never listed in
 * `standards:`. Since jit-context-system.md §4.1 this module is a
 * *projection* of the archetype resolution — it never reads a service's raw
 * fields directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as YAML from "yaml";

import { serviceStandards, validateServiceArchetypes } from "./archetypes.js";
import { loadArchetypes } from "./config.js";
import { standardsDirPath } from "./global_config.js";
import { run } from "./proc.js";

/**
 * Universal standards, in load order: always active, ungated by file type,
 * re-injected on any change — they never appear in a service's `standards:`
 * list. A *domain* standard, by contrast, only activates when a workspace's
 * archetype selects it and only re-injects when its `applies_to` globs match
 * the diff.
 *
 * Declared by the modules themselves (`universal: <n>` frontmatter), not by a
 * list in here: which standards form an org's always-on base is that org's
 * content, and this loader ships to orgs whose base is not ours. The number is
 * the load order — the base rubric reads before the constraints built on it,
 * and that ordering is deliberate rather than alphabetical luck, so it needs
 * somewhere explicit to live.
 */
export function universalStandards(modules: Record<string, Record<string, any>>): string[] {
  return Object.keys(modules)
    .filter((k) => typeof modules[k]["universal"] === "number")
    .sort((a, b) => modules[a]["universal"] - modules[b]["universal"] || (a < b ? -1 : 1));
}

const _GIT_TIMEOUT = 5; // seconds; this feeds a SessionStart hook — never hang a launch

function isDict(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Python `fnmatch.fnmatch` semantics: `*` matches everything INCLUDING `/`
 * (so `**` behaves the same as `*`), `?` matches one char, `[seq]` a class.
 * The diff-matching logic deliberately depends on these semantics — see the
 * ponytail note in `standardsMatchingDiff`.
 */
export function fnmatch(name: string, pat: string): boolean {
  let res = "";
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i++];
    if (c === "*") {
      res += ".*";
    } else if (c === "?") {
      res += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j++;
      if (j < n && pat[j] === "]") j++;
      while (j < n && pat[j] !== "]") j++;
      if (j >= n) {
        res += "\\[";
      } else {
        let stuff = pat.slice(i, j).replace(/\\/g, "\\\\");
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^")) stuff = "\\" + stuff;
        res += `[${stuff}]`;
        i = j + 1;
      }
    } else {
      res += escapeRegex(c);
    }
  }
  return new RegExp(`^(?:${res})$`, "s").test(name);
}

/**
 * Immediate subdirectories of *workspace* that are git repos/worktrees.
 *
 * Worktrees carry a `.git` file, standalone clones a `.git` dir —
 * `existsSync` covers both. Never throws: an unreadable workspace yields no
 * repos.
 */
export function repoDirs(workspace: string): string[] {
  try {
    return fs
      .readdirSync(workspace, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && fs.existsSync(path.join(workspace, e.name, ".git")),
      )
      .map((e) => path.join(workspace, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Repo-relative paths changed on this branch: branch-vs-base ∪ uncommitted.
 *
 * Best-effort and silent — any git failure, non-zero exit, or timeout
 * contributes nothing rather than throwing (this feeds a launch hook). Base
 * ref is the first of origin/main, main that resolves; if neither does, the
 * branch-scope diff is skipped and only uncommitted changes are reported.
 */
function changedPaths(repo: string): string[] {
  function git(...args: string[]): string[] {
    let res;
    try {
      res = run(["git", "-C", repo, ...args], { capture: true, timeout: _GIT_TIMEOUT });
    } catch {
      return [];
    }
    if (res.status !== 0) return [];
    return res.stdout.split("\n").filter((line) => line);
  }

  const paths = new Set<string>();

  const base = ["origin/main", "main"].find(
    (b) => git("rev-parse", "--verify", "--quiet", b).length,
  );
  if (base) {
    const mergeBase = git("merge-base", "HEAD", base);
    if (mergeBase.length) {
      for (const p of git("diff", "--name-only", `${mergeBase[0]}...HEAD`)) paths.add(p);
    }
  }

  // Uncommitted: porcelain lines are "XY <path>" (or "XY <old> -> <new>" on
  // rename); take the path column, unquote, keep the destination on renames.
  for (const line of git("status", "--porcelain")) {
    let p = line.slice(3);
    if (p.includes(" -> ")) {
      const parts = p.split(" -> ");
      p = parts[parts.length - 1];
    }
    p = p.trim().replace(/^"+|"+$/g, "");
    if (p) paths.add(p);
  }

  return [...paths].sort();
}

/**
 * (domain, summary) for every standard whose applies_to matches a file
 * changed on this branch, plus the universal `comments` base whenever any
 * file changed at all.
 *
 * Returns [] when nothing changed or no module resolves — the caller reads
 * empty as "inject no block". Never throws: the git layer is best-effort and
 * loadStandardsModules() skips malformed modules.
 */
export function standardsMatchingDiff(
  workspace: string,
  modules?: Record<string, Record<string, any>> | null,
): Array<[string, string]> {
  if (modules === undefined || modules === null) modules = loadStandardsModules();
  if (!Object.keys(modules).length) return [];

  const changed = new Set<string>();
  for (const repo of repoDirs(workspace)) {
    for (const p of changedPaths(repo)) changed.add(p);
  }
  if (!changed.size) return [];

  const universal = universalStandards(modules);
  const matched: Array<[string, string]> = [];
  for (const domain of Object.keys(modules).sort()) {
    if (universal.includes(domain)) continue;
    const meta = modules[domain];
    const globs: string[] = meta["applies_to"] ?? [];
    // ponytail: fnmatch maps '*'/'**' to '.*' but leaves '/' literal, so a
    // `**/*.service.ts` glob needs a slash — repo-root files under-match.
    // Harmless: `changed` paths are repo-relative and source lives in
    // subdirs, so they carry a slash; worst case = one standard not
    // re-injected. Swap to a real glob matcher if root-level matching ever
    // matters.
    let hit = false;
    for (const p of changed) {
      if (globs.some((g) => fnmatch(p, g))) {
        hit = true;
        break;
      }
    }
    if (hit) matched.push([domain, String(meta["summary"] ?? "").trim()]);
  }

  for (const uni of universal) {
    matched.push([uni, String(modules[uni]["summary"] ?? "").trim()]);
  }
  return matched;
}

/**
 * The standard-shaped files: flat `<key>.md` + `<key>/STANDARD.md`.
 *
 * The single source of this file set — both the loader and the structural
 * validator scan it, and the validator only works if it sees *exactly* what
 * the loader would load. Keeping the globs in one place makes that contract
 * self-enforcing (repos/*.md are excluded: not top-level, not STANDARD.md).
 */
function iterStandardFiles(standardsDir: string): string[] {
  const entries = fs.readdirSync(standardsDir, { withFileTypes: true });
  const flat = entries
    // A flat module is named for its domain, and a domain key is lowercase
    // kebab (`sb-<domain>-standard` is built from it). That excludes the
    // README.md / CONTRIBUTING.md a standards repo has at its root — which
    // otherwise parse as modules with no `domain:` and fail the structural
    // gate. Matching on shape rather than an ignore list means there is no
    // list to keep up to date.
    .filter((e) => /^[a-z0-9-]+\.md$/.test(e.name))
    .map((e) => path.join(standardsDir, e.name))
    .sort();
  const nested = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(path.join(standardsDir, e.name, "STANDARD.md")),
    )
    .map((e) => path.join(standardsDir, e.name, "STANDARD.md"))
    .sort();
  return [...flat, ...nested];
}

/**
 * Parse docs/standards/ modules (flat <key>.md or <key>/STANDARD.md) into
 * {domain: metadata}.
 *
 * Only top-level modules carry a `domain:` — the per-repo snippets under
 * repos/ are keyed by repo, not domain, and are not loadable standards.
 * Files without valid frontmatter are skipped (a malformed module should
 * not block workspace init).
 */
export function loadStandardsModules(
  standardsDir?: string | null,
): Record<string, Record<string, any>> {
  if (standardsDir === undefined || standardsDir === null) {
    standardsDir = standardsDirPath();
  }
  const modules: Record<string, Record<string, any>> = {};
  if (!(fs.existsSync(standardsDir) && fs.statSync(standardsDir).isDirectory())) {
    return modules;
  }
  for (const filePath of iterStandardFiles(standardsDir)) {
    const meta = parseFrontmatter(filePath);
    const domain = meta["domain"];
    if (!domain) continue;
    meta["path"] = filePath;
    if (path.basename(filePath) === "STANDARD.md") {
      const refs = path.join(path.dirname(filePath), "references");
      if (
        fs.existsSync(refs) &&
        fs.statSync(refs).isDirectory() &&
        fs.readdirSync(refs).some((n) => n.endsWith(".md"))
      ) {
        meta["references_dir"] = refs;
      }
    }
    modules[String(domain)] = meta;
  }
  return modules;
}

/** Frontmatter dict of a module file; `{}` on any read/parse failure. */
export function parseFrontmatter(filePath: string): Record<string, any> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  let data: unknown;
  try {
    data = YAML.parse(text.slice(4, end));
  } catch {
    return {};
  }
  return isDict(data) ? data : {};
}

/**
 * Return error strings for standards keys that resolve to no module.
 *
 * An unknown key means services.yaml and docs/standards/ have drifted —
 * surface it clearly at workspace time rather than silently dropping the
 * row. Also reports archetype drift (unknown `archetype:` reference,
 * both-forms conflict) via lib/archetypes.
 */
export function validateServiceStandards(
  servicesConfig: Record<string, any>,
  modules: Record<string, Record<string, any>>,
  archetypes?: Record<string, any> | null,
): string[] {
  if (archetypes === undefined || archetypes === null) archetypes = loadArchetypes();
  const errors = validateServiceArchetypes(servicesConfig, archetypes);

  for (const name of Object.keys(archetypes).sort()) {
    const arch = archetypes[name];
    if (!isDict(arch)) continue;
    for (const key of arch["standards"] ?? []) {
      // No universal-key exemption: a universal is a module like any other, so
      // `key in modules` already covers it.
      if (!(key in modules)) {
        errors.push(
          `services.yaml: archetype '${name}' lists unknown standard ` +
            `'${key}' — no docs/standards/${key}.md with \`domain: ${key}\``,
        );
      }
    }
  }

  for (const [svc, svcDef] of Object.entries(servicesConfig)) {
    if (!isDict(svcDef) || svcDef["archetype"]) continue;
    for (const key of svcDef["standards"] ?? []) {
      if (!(key in modules)) {
        errors.push(
          `services.yaml: service '${svc}' lists unknown standard '${key}' ` +
            `— no docs/standards/${key}.md with \`domain: ${key}\``,
        );
      }
    }
  }
  return errors;
}

/**
 * Structural integrity of the standards source tree (regression gate).
 *
 * Scans the standard-shaped files DIRECTLY — the same globs
 * loadStandardsModules uses — and parses each itself, rather than trusting
 * loadStandardsModules' output: that loader deliberately *drops* files with
 * malformed frontmatter or no domain (forgiving, so one bad edit can't break
 * workspace init), which is exactly why such breakage is silent. This
 * validator looks upstream of that safety net. Returns error strings; never
 * throws. repos/*.md are excluded (they are not *.md at top level nor
 * *\/STANDARD.md).
 */
export function validateStandardModules(standardsDir?: string | null): string[] {
  if (standardsDir === undefined || standardsDir === null) {
    standardsDir = standardsDirPath();
  }
  const errors: string[] = [];
  if (!(fs.existsSync(standardsDir) && fs.statSync(standardsDir).isDirectory())) {
    return errors;
  }

  for (const filePath of iterStandardFiles(standardsDir)) {
    const rel = path.relative(standardsDir, filePath);
    const meta = parseFrontmatter(filePath);

    const domain = meta["domain"];
    if (!(typeof domain === "string" && domain.trim())) {
      errors.push(`${rel}: unparseable frontmatter or missing \`domain:\``);
      continue; // every remaining check needs a parsed dict
    }

    const summary = meta["summary"];
    if (!(typeof summary === "string" && summary.trim())) {
      errors.push(`${rel}: missing or empty \`summary:\``);
    }

    const appliesTo = meta["applies_to"];
    if (
      !(
        Array.isArray(appliesTo) &&
        appliesTo.length &&
        appliesTo.every((g) => typeof g === "string" && g.trim())
      )
    ) {
      errors.push(
        `${rel}: \`applies_to:\` must be a non-empty list of non-empty globs ` +
          `(empty means the standard never loads and never re-injects)`,
      );
    }

    const phase = meta["phase"];
    if (
      phase !== undefined &&
      phase !== null &&
      !(
        Array.isArray(phase) &&
        phase.length &&
        phase.every((p) => typeof p === "string" && p.trim())
      )
    ) {
      errors.push(
        `${rel}: \`phase:\` if present must be a non-empty list of strings ` +
          `(a scalar string silently breaks skill_gen's substring gate)`,
      );
    }

    const universal = meta["universal"];
    if (universal !== undefined && universal !== null && !Number.isInteger(universal)) {
      errors.push(
        `${rel}: \`universal:\` if present must be an integer (its load order) ` +
          `— \`universal: true\` reads as universal but silently is not`,
      );
    }

    const expected =
      path.basename(filePath) === "STANDARD.md"
        ? path.basename(path.dirname(filePath))
        : path.basename(filePath, ".md");
    if (domain.trim() !== expected) {
      errors.push(
        `${rel}: \`domain: ${domain}\` does not match its location ` +
          `(expected \`${expected}\` — sb-<domain>-standard would diverge ` +
          `from where the standard lives)`,
      );
    }
  }

  return errors;
}

/**
 * Domains whose `task_signatures` appear in the workspace task text.
 *
 * Task-time routing, distinct from the edit-time gate: the starting_prompt /
 * task names the libraries and concepts up front (e.g. 'RemoteGraphQLDataSource',
 * 'federation'), so a domain the service selection didn't imply is surfaced
 * *before any code is authored* — the window the gate structurally misses,
 * since a Write payload already contains the drafted file. Case-insensitive
 * substring: a coarse net at the gate's altitude, not an import parser.
 */
export function domainsMatchingTaskText(
  taskText: string,
  modules: Record<string, Record<string, any>>,
): Set<string> {
  if (!taskText) return new Set();
  const haystack = taskText.toLowerCase();
  const matched = new Set<string>();
  for (const [key, meta] of Object.entries(modules)) {
    const sigs: any[] = meta["task_signatures"] ?? [];
    if (sigs.some((sig) => haystack.includes(String(sig).toLowerCase()))) {
      matched.add(key);
    }
  }
  return matched;
}

/**
 * Compute (active, notActive) standard keys for a workspace.
 *
 * Spec §5.3 resolution: union the standards of the workspace's services
 * (read through their archetypes — lib/archetypes normalizes the legacy
 * `standards:` form), apply workspace.yml `standards_override` add/remove,
 * always include the universal base. The workspace's *selected* services
 * (its declared intent) win over the repo-derived set — a monorepo like
 * a monorepo spans ui/graphql/api, so repo-level union would activate everything
 * for every workspace on it; a ui-only workspace must resolve to just
 * `comments, ui` (the spec's acceptance case). Repo-derived services are the
 * fallback when the workspace has no service selection. Only keys with a
 * real module survive (unknown keys are reported by
 * validateServiceStandards, not here). Both lists come back sorted with the
 * universal base first among active.
 */
export function resolveActiveStandards(
  repoNames: string[],
  servicesConfig: Record<string, any>,
  reposConfig: Record<string, any>,
  workspaceConfig?: Record<string, any> | null,
  modules?: Record<string, Record<string, any>> | null,
  localServices?: string[] | null,
  archetypes?: Record<string, any> | null,
): [string[], string[]] {
  if (modules === undefined || modules === null) modules = loadStandardsModules();
  if (archetypes === undefined || archetypes === null) archetypes = loadArchetypes();

  let candidateServices: string[];
  if (localServices && localServices.length) {
    candidateServices = [...localServices];
  } else {
    candidateServices = repoNames.flatMap(
      (repo) => (reposConfig[repo] ?? {})["services"] ?? [],
    );
  }

  const active = new Set<string>();
  for (const svc of candidateServices) {
    for (const key of serviceStandards(servicesConfig[svc], archetypes)) active.add(key);
  }

  const wc = workspaceConfig ?? {};
  const override = wc["standards_override"] ?? {};
  for (const key of override["add"] ?? []) active.add(key);
  // Task-time routing: surface domains the task text names but service
  // selection missed. Placed before `remove` so an explicit remove still
  // wins over a false-positive keyword match.
  const taskText = ["starting_prompt", "task", "description"]
    .map((k) => (wc[k] ? String(wc[k]) : ""))
    .join(" ");
  for (const key of domainsMatchingTaskText(taskText, modules)) active.add(key);
  for (const key of override["remove"] ?? []) active.delete(key);

  const universal = universalStandards(modules);
  for (const key of universal) active.add(key);
  for (const key of [...active]) {
    if (!(key in modules)) active.delete(key); // only keys that resolve to a real module
  }

  // Universals in their declared order (base first) — standardsMatchingDiff
  // honors the same order; alphabetical here only matched by coincidence.
  const sortKey = (k: string): [number, number, string] =>
    universal.includes(k) ? [0, universal.indexOf(k), ""] : [1, 0, k];
  const ordered = [...active].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  });
  const notActive = Object.keys(modules)
    .filter((k) => !active.has(k))
    .sort();
  return [ordered, notActive];
}

/**
 * The PreToolUse gate's manifest (`.sandbox/standards.json`, gate design
 * §2.2): domain -> {applies_to, summary} for every active non-universal
 * standard, plus the active universal keys. Built from
 * `resolveActiveStandards` output so it can never diverge from the CLAUDE.md
 * routing table — one compilation of the same resolution, not a second
 * source of truth.
 */
export function buildStandardsManifest(
  active: string[],
  modules: Record<string, Record<string, any>>,
): Record<string, any> {
  const universal = universalStandards(modules);
  const domains: Record<string, any> = {};
  for (const key of active) {
    if (universal.includes(key)) continue;
    domains[key] = {
      applies_to: Array.from((modules[key] ?? {})["applies_to"] ?? []),
      summary: String((modules[key] ?? {})["summary"] ?? "").trim(),
    };
  }
  return {
    generated_by: "sandbox init-workspace",
    universal: active.filter((key) => universal.includes(key)),
    domains,
  };
}

/**
 * Write the gate manifest to `.sandbox/standards.json` (projected artifact,
 * same do-not-hand-edit contract as the other generated files).
 */
export function writeStandardsManifest(
  workspaceRoot: string,
  manifest: Record<string, any>,
): string {
  const filePath = path.join(workspaceRoot, ".sandbox", "standards.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n");
  return filePath;
}
