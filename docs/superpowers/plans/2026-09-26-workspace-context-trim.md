# Workspace Context Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every generated workspace artifact carries only the context its sessions and phases use; the starting prompt reaches the session; the proxy smoke check has an owner.

**Architecture:** All changes are in the pure string generators of `packages/sandbox-core` (`claude_md.ts`, `agent_gen.ts`, `workspace_skills.ts`, `workspace_init.ts`, `generate.ts`), the hand-authored entry skills under `apps/cli/infra/skills/`, and the two docs that describe them. No new files except tests. Tests are `node:test` `.mjs` files that import from `./dist/` after `tsc`, following the existing pattern in that package.

**Tech Stack:** TypeScript (ESM), `node:test`, `tsc`. Run tests with `npm test` inside `packages/sandbox-core` (it compiles first).

**Spec:** `docs/superpowers/specs/2026-09-26-workspace-context-trim.md`

## Global Constraints

- Generated files keep their `AUTO-GENERATED — DO NOT EDIT` headers and generator pointers.
- Every failure path in init stays non-fatal: a missing ingress config or standards tree degrades the output, never aborts `sandbox init-workspace`.
- Skill and agent frontmatter is YAML; `description:` values that contain quotes stay `JSON.stringify`-quoted where they already are.
- `docs/jit-context-system.md` states current state only — update it in the same commit as the behaviour it describes.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work on a branch: `git checkout -b feat/workspace-context-trim` from `main` before Task 1.

## Review Focus

1. A workspace whose `workspace.yml` has a `starting_prompt` but whose notes dir already holds a **real** (non-placeholder) handoff must not get a second seed — Task 1's "a real handoff still blocks re-seeding" test pins it.
2. `sandbox skills check` on a workspace inited **before** this change reports the four inactive skills as `orphaned:` and `sync` removes them — Task 2's scope test pins the render side; Task 8 verifies the CLI end to end.
3. A machine with no `ingress:`/`feature_router:` config must still init: no smoke block, no feature URL, no throw — Task 5's "no routed service means no smoke block" test and Task 4's `try/catch` pin it.
4. A service whose `services.yaml` entry has no `path:` renders `.` in the Services table, not `undefined` — Task 4's test includes such a service.
5. Multi-repo workspaces keep the cross-repo `contract` row in the two-column routing table — Task 3's test builds a two-repo table.

---

### Task 1: Seed the starting prompt, supersede placeholders

**Files:**
- Modify: `packages/sandbox-core/workspace_init.ts:48` (imports), `:736-783` (`seedStartingHandoff`)
- Test: `packages/sandbox-core/workspace-init-seed.test.mjs` (create)

**Interfaces:**
- Produces: `export function seedStartingHandoff(workspaceRoot: string, startingPrompt: string, workType: string): void` — same signature, now exported; writes nothing when `startingPrompt` is blank.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/workspace-init-seed.test.mjs`:

```js
// The starting prompt is the most important context a workspace carries, and
// the old write-once seed lost it whenever the first init ran before the prompt
// existed: the placeholder it wrote blocked the real one forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { listNotes } from "./dist/notes.js";
import { seedStartingHandoff } from "./dist/workspace_init.js";

const PLACEHOLDER = `---
type: handoff
phase: research
author: workspace-creation
refs: []
status: open
---

# Handoff: workspace creation

This workspace is a feature — invoke \`sb-research\` first to explore and spec the work.

Seeded at workspace creation (no starting prompt was provided).
`;

function withWorkspace(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  try {
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("no prompt seeds nothing, even with a work type", () => {
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "", "feature");
    assert.deepEqual(listNotes(ws, true), []);
  });
});

test("a prompt seeds one handoff carrying it", () => {
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "## Goal\nShip it", "feature");
    const notes = listNotes(ws, true);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].type, "handoff");
    assert.match(notes[0].body, /Seeded from `starting_prompt`/);
    assert.match(notes[0].body, /Ship it/);
    assert.match(notes[0].body, /invoke `sb-research` first/);
  });
});

test("a placeholder from an older CLI is superseded when the prompt arrives", () => {
  withWorkspace((ws) => {
    const dir = path.join(ws, ".sandbox", "notes");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "001-handoff-starting-prompt.md"), PLACEHOLDER);
    seedStartingHandoff(ws, "## Goal\nShip it", "feature");
    const all = listNotes(ws, true);
    assert.equal(all.length, 2);
    assert.equal(all[0].frontmatter.status, "superseded");
    assert.match(all[1].body, /Ship it/);
    assert.equal(listNotes(ws).length, 1, "only the real handoff is live");
  });
});

test("a real handoff still blocks re-seeding", () => {
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "first", "feature");
    seedStartingHandoff(ws, "second", "feature");
    const all = listNotes(ws, true);
    assert.equal(all.length, 1);
    assert.match(all[0].body, /first/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test workspace-init-seed.test.mjs`
Expected: FAIL — `seedStartingHandoff` is not exported (`undefined is not a function`).

- [ ] **Step 3: Implement**

In `packages/sandbox-core/workspace_init.ts`, change the notes import on line 48 to:

```ts
import { listNotes, nextNoteNumber, noteFilename, notesDir, type Note } from "./notes.js";
```

Replace the whole `seedStartingHandoff` function (lines 736-783) with:

```ts
/**
 * A handoff seeded by an older CLI that had no prompt to carry. It blocks
 * nothing: the next init that has a prompt supersedes it (notes-conventions.md
 * rule 1).
 */
function isPlaceholderHandoff(note: Note): boolean {
  return (
    note.type === "handoff" &&
    note.frontmatter["author"] === "workspace-creation" &&
    !note.body.includes("Seeded from `starting_prompt`")
  );
}

function supersedeNote(note: Note): void {
  const text = fs.readFileSync(note.path, "utf8");
  fs.writeFileSync(note.path, text.replace(/^status:.*$/m, "status: superseded"));
}

/**
 * Seed the workspace's first handoff note from `starting_prompt`.
 *
 * Writes nothing without a prompt — the work-type line alone is already in
 * CLAUDE.md's by-phase table, and a placeholder used to block the real prompt
 * forever. Exported for its tests.
 */
export function seedStartingHandoff(workspaceRoot: string, startingPrompt: string, workType: string): void {
  const prompt = startingPrompt.trim();
  if (!prompt) {
    return;
  }
  const wt = workType.trim().toLowerCase();
  const [phase, firstSkill] = WORK_TYPE_PHASES[wt] ?? ["research", "invoke `sb-research` first"];
  try {
    const directory = notesDir(workspaceRoot);
    const handoffs = listNotes(workspaceRoot, true).filter((note) => note.type === "handoff");
    if (handoffs.some((note) => !isPlaceholderHandoff(note))) {
      return;
    }
    for (const placeholder of handoffs) {
      supersedeNote(placeholder);
    }
    fs.mkdirSync(directory, { recursive: true });
    const filename = noteFilename(nextNoteNumber(directory), "handoff", "starting-prompt");
    const lines = [
      "---",
      "type: handoff",
      `phase: ${phase}`,
      "author: workspace-creation",
      "refs: []",
      "status: open",
      "---",
      "",
      "# Handoff: workspace creation",
      "",
    ];
    if (wt) {
      lines.push(`This workspace is a ${wt} — ${firstSkill}.`, "");
    }
    lines.push(
      "Seeded from `starting_prompt` in .sandbox/workspace.yml when the",
      "workspace was created. The task below has not begun — confirm",
      "direction with the user before executing it.",
      "",
      prompt,
    );
    fs.writeFileSync(path.join(directory, filename), lines.join("\n") + "\n");
    success(`Seeded starting handoff → .sandbox/notes/${filename}`);
  } catch (exc) {
    warn(`Could not seed starting handoff: ${(exc as Error).message}`);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/sandbox-core && npm test`
Expected: all pass, including the four new ones.

- [ ] **Step 5: Update the conventions doc**

In `docs/notes-conventions.md` line 21-24, replace:

```
   first `handoff` note (`author: workspace-creation`; skipped if any handoff note
   exists, so it never duplicates or resurrects; a later edit to `workspace.yml`'s
   `starting_prompt` does not update the note).
```

with:

```
   first `handoff` note (`author: workspace-creation`; written only when a prompt
   exists; skipped if a real handoff note exists, so it never duplicates or
   resurrects; a placeholder seeded by an older CLI is superseded when the prompt
   arrives).
```

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/workspace_init.ts packages/sandbox-core/workspace-init-seed.test.mjs docs/notes-conventions.md
git commit -m "fix(core): seed the starting prompt even after a placeholder handoff

The write-once seed wrote a placeholder when init ran before the prompt
existed, and the placeholder then blocked the real prompt forever — the
SessionStart hook re-injected 'no starting prompt was provided' every
session. Placeholders are now superseded; nothing is seeded without a prompt.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Project only the active standards

**Files:**
- Modify: `packages/sandbox-core/workspace_skills.ts` (`renderWorkspaceSkills`, `writeWorkspaceSkills`, `checkWorkspaceSkills`, `resolveWorkspaceManifest`, `checkSkills`, `checkStandardsManifest`, `syncSkills`)
- Modify: `packages/sandbox-core/workspace_init.ts:905-926` (capture `active`), `:955` (pass it)
- Modify: `apps/cli/src/commands/skills.ts:38-70`
- Test: `packages/sandbox-core/workspace-skills-scope.test.mjs` (create)

**Interfaces:**
- Produces: `renderWorkspaceSkills(standardsDir?, entrySkillsDir?, active?: string[] | null)`, `writeWorkspaceSkills(workspaceRoot, standardsDir?, entrySkillsDir?, active?)`, `checkWorkspaceSkills(workspaceRoot, standardsDir?, entrySkillsDir?, active?)`.
- Produces: `resolveWorkspaceActive(workspace): { active: string[]; modules: Record<string, Record<string, any>> } | null`.
- Changes: `checkSkills(workspace, active?: string[] | null)`, `checkStandardsManifest(workspace, resolved?: ReturnType<typeof resolveWorkspaceActive>)`.
- Consumes: `skillNameFor(domain)` from `skill_gen.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/workspace-skills-scope.test.mjs`:

```js
// A standard that is not projected cannot be loaded — the same "cannot
// misbehave" logic as the subagent tool gates, applied to the skill set.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { renderWorkspaceSkills } from "./dist/workspace_skills.js";

const MODULE = (domain) =>
  `---\ndomain: ${domain}\nsummary: ${domain} rules\napplies_to:\n  - '**/*.ts'\n---\n\n# ${domain}\n`;

function withTree(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-scope-"));
  try {
    for (const d of ["alpha", "beta"]) fs.writeFileSync(path.join(dir, `${d}.md`), MODULE(d));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("no active list projects every standard", () => {
  withTree((dir) => {
    const names = Object.keys(renderWorkspaceSkills(dir, null, null));
    assert.ok(names.includes("sb-alpha-standard"));
    assert.ok(names.includes("sb-beta-standard"));
  });
});

test("an active list keeps only those standards and every entry skill", () => {
  withTree((dir) => {
    const names = Object.keys(renderWorkspaceSkills(dir, null, ["alpha"]));
    assert.ok(names.includes("sb-alpha-standard"));
    assert.ok(!names.includes("sb-beta-standard"));
    assert.ok(names.includes("sb-implement"), "entry skills are never filtered");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test workspace-skills-scope.test.mjs`
Expected: the second test FAILS (`sb-beta-standard` is present).

- [ ] **Step 3: Implement the filter and the shared resolver**

In `packages/sandbox-core/workspace_skills.ts`:

Change the skill_gen import to:

```ts
import { generateSkills, skillNameFor, validateModuleReferences } from "./skill_gen.js";
```

Replace `renderWorkspaceSkills` (signature through the first `try` block) with:

```ts
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
```

(the rest of the function is unchanged).

Add `active?: string[] | null` as the last parameter of `writeWorkspaceSkills` and `checkWorkspaceSkills`, and pass it through: `renderWorkspaceSkills(standardsDir, entrySkillsDir, active)` in both.

Replace `resolveWorkspaceManifest` with:

```ts
/**
 * The workspace's active standard keys, re-resolved from what it persisted
 * (repo worktrees on disk + `.sandbox/workspace.yml`) — `sandbox skills
 * sync`/`check` run standalone, without init's original CLI args. Null when
 * no standards modules exist (nothing to scope or check).
 */
export function resolveWorkspaceActive(
  workspace: string,
): { active: string[]; modules: Record<string, Record<string, any>> } | null {
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
  return { active, modules };
}

/** Recompute the gate manifest for an already-initialized workspace. */
export function resolveWorkspaceManifest(
  workspace: string,
  resolved: ReturnType<typeof resolveWorkspaceActive> = resolveWorkspaceActive(workspace),
): Record<string, any> | null {
  if (resolved === null) {
    return null;
  }
  return buildStandardsManifest(resolved.active, resolved.modules);
}
```

Replace `checkSkills`, `checkStandardsManifest` and `syncSkills` with:

```ts
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
```

- [ ] **Step 4: Wire the CLI and init**

In `apps/cli/src/commands/skills.ts`, add `resolveWorkspaceActive` to the `sandbox-core/workspace_skills` import and replace the body of `run` after the `sync` early-return with:

```ts
  // Resolved once, up front: it reads .sandbox/workspace.yml (one [info] line)
  // and both drift sources below take the result.
  const resolved = resolveWorkspaceActive(workspace);
  const { authoring, drift } = checkSkills(workspace, resolved?.active ?? null);
  for (const entry of authoring) {
    printDrift(entry);
  }
  for (const entry of drift) {
    printDrift(entry);
  }

  const manifestDrift = checkStandardsManifest(workspace, resolved);
```

(the rest of `run` is unchanged). Update the file's header comment: delete the sentence beginning "After the projected-skill report, because resolving the manifest logs." if present at the call site.

In `packages/sandbox-core/workspace_init.ts` step 5b: declare `let activeStandards: string[] | null = null;` next to `let standardsSection`, and inside the `if (Object.keys(modules).length)` block after `const [active, notActive] = ...` add `activeStandards = active;`. Change step 6a to:

```ts
  for (const skillPath of writeWorkspaceSkills(workspaceRoot, null, null, activeStandards)) {
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/sandbox-core && npm test && cd ../../apps/cli && npm run typecheck`
Expected: all pass; the existing "a workspace with no projected skills is all drift" test still passes (an empty temp dir resolves to universals only, and every one of those is still `missing:`).

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/workspace_skills.ts packages/sandbox-core/workspace-skills-scope.test.mjs packages/sandbox-core/workspace_init.ts apps/cli/src/commands/skills.ts
git commit -m "feat(core): project only the workspace's active standards

Inactive standards were rendered into .claude/skills/ and then told 'do not
load' from the routing table. A skill that is not there cannot be loaded.
skills check/sync resolve the active set the same way init does.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Trim CLAUDE.md — no Feature Testing, no service map, one phase chain

**Files:**
- Modify: `packages/sandbox-core/claude_md.ts:20-46` (export `resolveProxyHost`), `:58-118` (delete `buildFeatureTestingSection`), `:120-163` (`buildRoutingTable`), `:165-245` (`buildStandardsRoutingSection`), `:247-335` (`buildClaudeMd`)
- Modify: `packages/sandbox-core/workspace_init.ts:367` (`_INFRA_DEPS`), `:596-680` (delete `buildServiceMapMd`), `:883-899` (delete step 5), `:913-921`, `:942-950`
- Test: `packages/sandbox-core/claude-md.test.mjs` (create)

**Interfaces:**
- Produces: `export function resolveProxyHost(serviceNames: string[]): { host: string; domain: string } | null` (Task 4 and 5 consume it).
- Produces: `buildRoutingTable(repos, workspaceRoot, hasFeature)`, `buildStandardsRoutingSection(active, modules, repoNames)`, `buildClaudeMd(workspaceName, workspaceRoot, repos, task, meta, standardsSection = null)`.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/claude-md.test.mjs`:

```js
// CLAUDE.md is the always-on file, so everything it carries is paid on every
// turn. These pin what left it: the Feature Testing section, the service-map
// column, the duplicated phase-entry paragraph, the 'do not load' line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildClaudeMd, buildRoutingTable, buildStandardsRoutingSection } from "./dist/claude_md.js";

// `universal: <n>` is what the loader stamps on UNIVERSAL_STANDARDS modules.
const MODULES = {
  comments: { summary: "why not what", applies_to: ["**/*"], universal: 0 },
  engineering: { summary: "constraints", applies_to: ["**/*"], universal: 1 },
  ui: { summary: "ui rules", applies_to: ["**/*.tsx"] },
};

function withDir(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-md-"));
  try {
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("the standards section states the phase chain once, with no inactive list", () => {
  const out = buildStandardsRoutingSection(["comments", "engineering", "ui"], MODULES, ["demo"]);
  assert.match(out, /\| ui \| `sb-ui-standard` \| `\*\*\/\*\.tsx` \|/);
  assert.doesNotMatch(out, /Not active/);
  assert.doesNotMatch(out, /\*\*Phase entry:\*\*/);
  assert.doesNotMatch(out, /workspace root/);
  assert.equal((out.match(/`sb-implement`/g) ?? []).length, 1);
  assert.match(out, /\| Phase \| Invoke first \| Loads \|/);
  assert.match(out, /universal base \(`ponytail` \+ `sb-comments-standard` \+ `sb-engineering-standard`\)/);
});

test("the routing table is two columns: one feature row, contract row only for multi-repo", () => {
  withDir((ws) => {
    fs.mkdirSync(path.join(ws, "a"));
    fs.writeFileSync(path.join(ws, "a", "CLAUDE.md"), "# a\n");
    const single = buildRoutingTable([["a", "u/x"]], ws, true);
    assert.equal(single.split("\n")[0], "| Task | Read |");
    assert.match(single, /\| Working in a \| a\/CLAUDE\.md \|/);
    assert.match(single, /\| Running the feature[^|]*\| \.sandbox\/sandbox-context\.md \|/);
    assert.doesNotMatch(single, /Cross-repo/);
    assert.doesNotMatch(single, /service-map/);
    const multi = buildRoutingTable([["a", "u/x"], ["b", "u/x"]], ws, false);
    assert.match(multi, /\| Cross-repo contract change \| \.sandbox\/notes\/ \(`contract` notes\) \|/);
    assert.doesNotMatch(multi, /Working in b/, "no row for a repo CLAUDE.md that does not exist");
  });
});

test("CLAUDE.md carries no Feature Testing section", () => {
  withDir((ws) => {
    const out = buildClaudeMd(
      "test",
      ws,
      [["demo", "u/test"]],
      "Task",
      { FEATURE: "test", SERVICES: "frontend", TEST_PATH: "/" },
      "## Standards routing\n\n(stub)\n",
    );
    assert.doesNotMatch(out, /## Feature Testing/);
    assert.doesNotMatch(out, /document\.cookie/, "the cookie one-liner lives in sandbox-context.md now");
    assert.match(out, /Running the feature — URL, X-Feature cookie/, "the routing row still points at it");
    assert.match(out, /## Notes/);
    assert.match(out, /## Standards routing/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test claude-md.test.mjs`
Expected: all three FAIL (phase-entry paragraph present; three-column table; Feature Testing present / wrong arity).

- [ ] **Step 3: Implement in `claude_md.ts`**

Make `resolveProxyHost` exported (line 30: `export function resolveProxyHost(`).

Delete `buildFeatureTestingSection` entirely (the doc comment at line 58 through the closing brace at line 118). Update the module docstring line 10: `its routing table, and \`.sandbox/sandbox-context.md\`.`

Replace `buildRoutingTable`:

```ts
/**
 * Build the routing table for CLAUDE.md.
 *
 * Per-repo routing rows are only emitted when `{repo}/CLAUDE.md` actually
 * exists — pointing at a file that isn't there is worse than no row at all.
 * Everything about the running feature (URL, cookie, ports, lifecycle, health
 * checks) is one row: it all lives in sandbox-context.md.
 */
export function buildRoutingTable(
  repos: Array<[string, string]>,
  workspaceRoot: string,
  hasFeature: boolean,
): string {
  const rows: string[] = [];

  for (const [name] of repos) {
    let isFile = false;
    try {
      isFile = fs.statSync(path.join(workspaceRoot, name, "CLAUDE.md")).isFile();
    } catch {
      /* missing — no row */
    }
    if (isFile) {
      rows.push(`| Working in ${name} | ${name}/CLAUDE.md |`);
    }
  }

  if (hasFeature) {
    rows.push(
      "| Running the feature — URL, X-Feature cookie, ports, lifecycle, health checks | .sandbox/sandbox-context.md |",
    );
  }

  if (repos.length > 1) {
    rows.push("| Cross-repo contract change | .sandbox/notes/ (`contract` notes) |");
  }

  if (rows.length === 0) {
    return "";
  }

  return "| Task | Read |\n|------|------|\n" + rows.join("\n");
}
```

In `buildStandardsRoutingSection`: remove the `notActive: string[]` parameter and the `notActiveLine` const. Replace the returned template from `${notActiveLine}**Phase entry:**` through the end of the by-phase table with:

```ts
**By phase** — invoke the entry skill before starting the phase:

| Phase | Invoke first | Loads |
|-------|--------------|-------|
| research / planning | \`sb-research\` | nothing — spawns the read-only \`sb-researcher\` agent |
| implementing (before the first code edit) | \`sb-implement\` | universal base (${universalSkills}) + rows matching the files you edit |
| testing | \`sb-test\` | nothing — spawns the matching \`sb-tester-<archetype>\` agent(s) |
| review (before reading any diff or PR) | \`sb-review\` | the standards covering files in the diff |
| PR / finishing | \`sb-pr\` | nothing — runs the pre-PR gate, then \`sb-review\` |

`;
```

so that the `${rows.join("\n")}` table is followed by one blank line and then this block. Update the function's doc comment to drop the "must name them" sentence about the phase-entry paragraph (the table names them).

In `buildClaudeMd`: remove the `hasServiceMap = false` parameter; change the `buildRoutingTable` call to `buildRoutingTable(repos, workspaceRoot, hasFeature)`; delete `const featureTesting = buildFeatureTestingSection(meta);`; change the final template's last line to `${codeStandardsSection}${notesSection}`.

- [ ] **Step 4: Implement in `workspace_init.ts`**

- Delete `const _INFRA_DEPS = ...` (line 367).
- Delete the "Service map generation" block: from the `// ----` comment line above `// Service map generation` through the closing brace of `buildServiceMapMd` (lines 595-680).
- Delete step 5 (the `// 5. Generate .sandbox/service-map.md` comment through the closing `}` of `if (repos.length) {`, lines 883-899) including `let hasServiceMap = false;`.
- Step 5b: `const [active] = resolveActiveStandards(` (drop `notActive`) and `standardsSection = buildStandardsRoutingSection(active, modules, repoNames);`.
- Step 6: remove the `hasServiceMap,` argument from the `buildClaudeMd(...)` call.
- Renumber the step comments (5b → 5, 6 stays) only if it takes one edit each; otherwise leave them.

- [ ] **Step 5: Run the tests**

Run: `cd packages/sandbox-core && npm test && cd ../../apps/cli && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/claude_md.ts packages/sandbox-core/workspace_init.ts packages/sandbox-core/claude-md.test.mjs
git commit -m "refactor(core): trim the workspace CLAUDE.md to its routing job

Feature Testing moves out (sandbox-context.md and the tester agent carry it —
next commits), service-map.md is gone (its Services table duplicated
sandbox-context.md and nothing routed to it), the phase chain is stated once,
and the operator note about the workspace root goes back to the docs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Scope `sandbox-context.md` to the workspace and give it the feature URL

**Files:**
- Modify: `packages/sandbox-core/claude_md.ts` (`buildSandboxContextMd`, lines 341-569 after Task 3's renumbering)
- Modify: `packages/sandbox-core/generate.ts:1421-1426` (signature), `:1504-1511` (call)
- Modify: `packages/sandbox-core/workspace_init.ts` (the `generateWorkspaceCompose` call in step 8)
- Test: `packages/sandbox-core/sandbox-context.test.mjs` (create)

**Interfaces:**
- Produces: `buildSandboxContextMd(feature, slot, portStart, portEnd, localServices, servicesConfig, testPath = "")`.
- Produces: `generateWorkspaceCompose(feature, servicesStr, workspaceRoot, testPath = "")` — replaces the unused `_allocateSlotFn?: unknown` parameter (confirmed unreferenced in the body).
- Consumes: `resolveProxyHost` (Task 3), `loadFeatureRouters` from `feature_routing.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/sandbox-context.test.mjs`:

```js
// sandbox-context.md is loaded on demand, but when it loads it should describe
// this workspace — not every host on the machine and a hardcoded infra table
// whose ports had already drifted from the registry.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSandboxContextMd } from "./dist/claude_md.js";
import { loadServices } from "./dist/config.js";
import { withSandboxHome } from "./fixtures.mjs";

const SERVICES = `services:
  frontend:
    type: web
    repo: demo-repo
    path: apps/frontend
    port_offset: 1
    feature_router: {}
  backend:
    type: api
    repo: demo-repo
    path: apps/backend
    port_offset: 2
    k8s_forward_port: 9052
    feature_router: {}
  dashboard:
    type: web
    repo: other
    port_offset: 3
    k8s_forward_port: 9060
    feature_router: {}
`;

test("health checks and the feature URL are scoped to the local services", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices(), "/");
      const curls = out.match(/curl -sk -b "X-Feature=test"[^\n]*/g) ?? [];
      assert.equal(curls.length, 1, curls.join("\n"));
      assert.match(curls[0], /frontend\.local\.sandbox\.com/);
      assert.match(out, /\*\*Feature URL:\*\* https:\/\/frontend\.local\.sandbox\.com\//);
      assert.match(out, /document\.cookie = "X-Feature=test; domain=\.local\.sandbox\.com; path=\/; SameSite=Lax"/);
      assert.match(out, /frontend\.local\.sandbox\.com\/__sandbox/);
      assert.match(out, /\| `frontend` \| local \| `apps\/frontend` \| `test-frontend` \| 11101 \|/);
      assert.match(out, /\| `backend` \| k8s \| `apps\/backend` \| — \| — \|/);
      assert.match(out, /\| `dashboard` \| k8s \| `\.` \|/, "a service without path: renders '.'");
      assert.doesNotMatch(out, /## Infrastructure/);
      assert.match(out, /- `https:\/\/dashboard\.local\.sandbox\.com`/, "the routed-host list stays machine-wide");
    },
    { services: SERVICES },
  );
});

test("no test path means the feature URL is the host root", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices());
      assert.match(out, /\*\*Feature URL:\*\* https:\/\/frontend\.local\.sandbox\.com\/\n/);
    },
    { services: SERVICES },
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test sandbox-context.test.mjs`
Expected: FAIL — four curls, no Feature URL, `## Infrastructure` present, no path column.

- [ ] **Step 3: Implement in `claude_md.ts`**

Signature:

```ts
export function buildSandboxContextMd(
  feature: string,
  slot: number,
  portStart: number,
  portEnd: number,
  localServices: string[],
  servicesConfig: Record<string, any>,
  testPath = "",
): string {
```

After the `routedHosts` block, add the local-host list used by the health checks:

```ts
  // Health checks are per workspace: only the hosts of services this feature
  // runs locally. The routed-host list below stays machine-wide — it describes
  // what Caddy terminates, which is a fact about the proxy, not the feature.
  let localHosts: string[] = [];
  try {
    const routers = loadFeatureRouters(servicesConfig);
    localHosts = localServices
      .map((svc) => routers[svc]?.hostname)
      .filter((h): h is string => Boolean(h))
      .sort();
  } catch {
    localHosts = [];
  }
```

Services table: add a `Path in repo` column. Local rows become:

```ts
    serviceRows.push(
      `| \`${svc}\` | local | \`${svcDef["path"] ?? "."}\` | \`${feature}-${svc}\` | ${hostPort} | \`${envVar}=http://${svc}:${internalPort}\` |`,
    );
```

k8s rows become:

```ts
    serviceRows.push(
      `| \`${svc}\` | k8s | \`${svcDef["path"] ?? "."}\` | — | — | \`${envVar}=http://k8s-forwards:${port}\` |`,
    );
```

and the header:

```ts
    servicesTable =
      "| Service | Location | Path in repo | Container | Host Port | In-cluster URL (env var) |\n" +
      "|---------|----------|--------------|-----------|-----------|--------------------------|\n" +
      serviceRows.join("\n");
```

Health checks: in the `localServices.length > 0` branch, build `proxyCheck` from `localHosts` instead of `routedHosts`, and omit it when empty:

```ts
    const proxyCheck = localHosts.length
      ? "# Through Caddy (verifies full proxy routing):\n" +
        localHosts
          .map(
            (host) =>
              `curl -sk -b "X-Feature=${feature}" -o /dev/null -w "HTTP %{http_code} | Size: %{size_download}\\n" ` +
              `"https://${host}/"\n`,
          )
          .join("") +
        "\n"
      : "";
```

Feature block, computed before the return:

```ts
  const proxy = resolveProxyHost(localServices);
  const featureBlock = proxy
    ? `
**Feature URL:** https://${proxy.host}/${testPath.replace(/^\/+/, "")}

Set the routing cookie in the browser (DevTools console):

\`\`\`js
document.cookie = "X-Feature=${feature}; domain=.${proxy.domain}; path=/; SameSite=Lax";
\`\`\`

or visit https://${proxy.host}/__sandbox and select \`${feature}\` — the selector is served on every routed host and the cookie applies to each host sharing the base domain.
`
    : "";
```

In the template: delete the whole `## Infrastructure` section (heading through the Redis row and its trailing blank line). In `## Proxy Routing`, replace the paragraph starting `**Sandbox selector UI (\`/__sandbox\`):**` with `${featureBlock}`.

- [ ] **Step 4: Thread `testPath` through `generate.ts` and init**

`generate.ts` signature:

```ts
export async function generateWorkspaceCompose(
  feature: string,
  servicesStr: string,
  workspaceRoot: string,
  testPath = "",
): Promise<number | null> {
```

and the call near line 1504 gains `testPath` as its last argument.

`workspace_init.ts` step 8:

```ts
    const slot = await generateWorkspaceCompose(
      feature,
      meta["SERVICES"] ?? "",
      workspaceRoot,
      (meta["TEST_PATH"] ?? "").trim(),
    );
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/sandbox-core && npm test && cd ../../apps/cli && npm run typecheck && npm test`
Expected: all pass (the CLI's `generate_workspace_compose.test.ts` still calls with three arguments).

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/claude_md.ts packages/sandbox-core/generate.ts packages/sandbox-core/workspace_init.ts packages/sandbox-core/sandbox-context.test.mjs
git commit -m "feat(core): scope sandbox-context.md to the workspace

Health checks only for the feature's own hosts, the feature URL and browser
cookie that CLAUDE.md used to carry, a path column so service-map.md is not
missed, and no hardcoded Infrastructure table (its MongoDB port collided with
the registry's backend forward).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Tester smoke check, researcher method, no CLAUDE.md pointer

**Files:**
- Modify: `packages/sandbox-core/agent_gen.ts` (imports, `buildResearcherAgent`, `buildTesterSpecs`, `buildTesterAgent`)
- Modify: `packages/sandbox-core/workspace_init.ts` (imports; step 6b)
- Test: `packages/sandbox-core/agent-gen.test.mjs` (create)

**Interfaces:**
- Produces: `buildTesterSpecs(presentArchetypes, servicesConfig, archetypes, feature = "", routers: Record<string, FeatureRouter> = {}, testPath = "")`; each spec gains `feature: string` and each service gains `url: string | null`.
- Consumes: `FeatureRouter`, `loadFeatureRouters` from `feature_routing.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/agent-gen.test.mjs`:

```js
// Phase gates tools, archetype gates context (§5.4): the tester is the one
// generated artifact with Bash, so it owns the proxy smoke check; the
// researcher is the one that investigates, so it owns the method.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildResearcherAgent, buildTesterAgent, buildTesterSpecs } from "./dist/agent_gen.js";

const SERVICES = {
  frontend: { repo: "demo", archetype: "node-web" },
  worker: { repo: "demo", archetype: "node-web" },
};
const ARCHETYPES = { "node-web": { standards: ["ui"], test: "npm test" } };
const ROUTERS = { frontend: { hostname: "frontend.local.sandbox.com" } };

test("a routed service gets a smoke url, an unrouted one does not", () => {
  const [spec] = buildTesterSpecs({ "node-web": ["frontend", "worker"] }, SERVICES, ARCHETYPES, "test", ROUTERS, "/");
  const byName = Object.fromEntries(spec.services.map((s) => [s.name, s]));
  assert.equal(byName.frontend.url, "https://frontend.local.sandbox.com/");
  assert.equal(byName.worker.url, null);
  assert.equal(spec.feature, "test");
});

test("the tester body carries the guarded curl and no CLAUDE.md pointer", () => {
  const [spec] = buildTesterSpecs({ "node-web": ["frontend"] }, SERVICES, ARCHETYPES, "test", ROUTERS, "");
  const body = buildTesterAgent(spec);
  assert.match(body, /PROXY SMOKE CHECK/);
  assert.match(body, /docker ps --format '\{\{\.Names\}\}' \| grep -x test-frontend/);
  assert.match(body, /curl -sk -b "X-Feature=test" -o \/dev\/null -w "HTTP %\{http_code\}\\n" "https:\/\/frontend\.local\.sandbox\.com\/"/);
  assert.doesNotMatch(body, /read CLAUDE\.md first/);
  assert.match(body, /run from `demo\/`: `npm test`/, "the unit-test lines are unchanged");
});

test("no routed service means no smoke block and no throw", () => {
  const [spec] = buildTesterSpecs({ "node-web": ["frontend"] }, SERVICES, ARCHETYPES, "test", {}, "");
  assert.doesNotMatch(buildTesterAgent(spec), /PROXY SMOKE CHECK/);
  const [legacy] = buildTesterSpecs({ "node-web": ["frontend"] }, SERVICES, ARCHETYPES);
  assert.doesNotMatch(buildTesterAgent(legacy), /PROXY SMOKE CHECK/);
});

test("the researcher carries the investigation method, phrased for a subagent", () => {
  const body = buildResearcherAgent();
  for (const heading of [
    "Present options, don't pick",
    "Tag every non-trivial claim",
    "Anti-relitigation",
    "Bound the investigation",
    "named, not loaded",
    "Deliverable shape",
  ]) {
    assert.ok(body.includes(heading), heading);
  }
  assert.doesNotMatch(body, /AskUserQuestion/);
  assert.doesNotMatch(body, /read CLAUDE\.md first/);
  assert.match(body, /RETURN CONTRACT/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test agent-gen.test.mjs`
Expected: all four FAIL.

- [ ] **Step 3: Implement `agent_gen.ts`**

Imports:

```ts
import { serviceTestCommand } from "./archetypes.js";
import type { FeatureRouter } from "./feature_routing.js";
```

`buildResearcherAgent`: replace the line `Workspace context: read CLAUDE.md first (routing + standards tables).` and insert the method **before** `RETURN CONTRACT`, so the body reads (from after `${_GENERATED_NOTICE}`):

```ts
You investigate code in this workspace and report findings. Do not modify
source files — the implement phase is a separate, user-invoked step. Your
Write tool exists solely for the note below.

HOW TO INVESTIGATE — the prompt you were given names the scope (in vs. out),
whether this is a spike or ship-ready, the givens to hold constant, and the
deliverable shape. If any is missing, state the assumption you made and record
it under OPEN QUESTIONS; do not silently expand your own mandate.

- Present options, don't pick. Default to 2–3 viable approaches with explicit
  tradeoffs; recommend only if the prompt asks. Silently converging on one
  option and designing only that is the single most common research over-reach.
- Check whether it already exists first. Before proposing anything new, search
  for an existing pattern, resolver, service, or utility that already solves
  this. State what you looked for and what you found — or didn't.
- Tag every non-trivial claim by how you know it: Verified (read the actual
  code/config/schema — cite the file:line), Inferred (reasoned from adjacent
  evidence — say what it rests on), Assumed (a given or a default —
  unconfirmed, flagged so a reviewer can challenge it). Never present inferred
  or assumed as verified; an honest "I couldn't confirm X" beats a confident
  guess.
- Anti-relitigation. Hold the listed givens constant. A workspace \`decision\`
  note is a given and is binding. If a given genuinely looks wrong, flag it as
  a separate finding ("this assumption may not hold, because…") and keep it out
  of the main recommendation.
- Bound the investigation. Prefer the smallest investigation that answers the
  question with adequate confidence — don't read every file in a repo when
  three answer it. If it balloons, stop and report what you have plus what is
  still open.
- Validate against the code standards — named, not loaded. Check each option
  against \`sb-engineering-standard\` (architectural fit, additive/reversible
  change, performance budgets, PR sizing) and any domain standard the change
  would touch. Do not load those skills — this phase is read-only; name them
  as the validation target. An option that violates a standard is not viable:
  fix it or record the violation as a tradeoff.
- Deliverable shape — converge on something a human can act on. Options
  analysis (default): scope & givens · existing prior art · options (approach,
  tradeoffs, standards fit, evidence tags) · recommendation if requested · open
  questions. ADR: context, decision, alternatives, both directions of
  consequence. Research story: problem statement, findings, proposed approach,
  acceptance criteria, links to verified sources.

RETURN CONTRACT — before returning, persist your full findings as a
workspace note:
```

(the numbered contract steps stay exactly as they are; the trailing `Workspace context:` line is deleted).

`buildTesterSpecs`:

```ts
export function buildTesterSpecs(
  presentArchetypes: Record<string, string[]>,
  servicesConfig: Record<string, any>,
  archetypes: Record<string, any>,
  feature = "",
  routers: Record<string, FeatureRouter> = {},
  testPath = "",
): Array<Record<string, any>> {
  const specs: Array<Record<string, any>> = [];
  for (const [archName, svcNames] of Object.entries(presentArchetypes)) {
    const arch = archetypes[archName] ?? {};
    const services: Array<Record<string, any>> = [];
    for (const svc of svcNames) {
      const svcDef = servicesConfig[svc] ?? {};
      const host = routers[svc]?.hostname;
      services.push({
        name: svc,
        repo: svcDef["repo"],
        command: serviceTestCommand(svc, svcDef, archetypes),
        // The through-Caddy URL for the smoke check; null when the service has
        // no feature_router host (nothing to curl) or no feature is known.
        url: feature && host ? `https://${host}/${testPath.replace(/^\/+/, "")}` : null,
      });
    }
    specs.push({
      archetype: archName,
      services,
      standards: [...(arch["standards"] ?? [])],
      feature,
    });
  }
  return specs;
}
```

Update its doc comment: "…the archetype's services with their repo, resolved test command and through-Caddy URL, the archetype's standards keys, and the feature name."

`buildTesterAgent`: after `const commands = commandLines.join("\n");` add:

```ts
  const feature = spec["feature"] ?? "";
  const smokeLines = services
    .filter((s) => s["url"])
    .map(
      (s) =>
        `- ${s["name"]} — guard: \`docker ps --format '{{.Names}}' | grep -x ${feature}-${s["name"]}\`\n` +
        `  check: \`curl -sk -b "X-Feature=${feature}" -o /dev/null -w "HTTP %{http_code}\\n" "${s["url"]}"\``,
    );
  const smokeBlock = smokeLines.length
    ? `
PROXY SMOKE CHECK — after the unit tests. For each service below run the
guard first; if it prints nothing, report the check SKIPPED (container not
running) — never start containers yourself. Otherwise run the check and
report the HTTP code; anything other than 2xx/3xx is a failing result with
the code as the assertion.
${smokeLines.join("\n")}
`
    : "";
```

and in the returned template insert `${smokeBlock}` on its own line directly after `${commands}`, and delete the final `Workspace context: read CLAUDE.md first (routing + standards tables).` line (and its preceding blank line).

- [ ] **Step 4: Wire init**

In `workspace_init.ts` imports add:

```ts
import { loadFeatureRouters, type FeatureRouter } from "./feature_routing.js";
```

Step 6b becomes:

```ts
  // 6b. Generated subagents: sb-researcher plus one sb-tester-<archetype> per
  // archetype present. Routers feed the tester's proxy smoke check; a machine
  // with no ingress config gets testers without one, never a failed init.
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const archetypes = loadArchetypes();
  const present = resolvePresentArchetypes(
    repos.map(([name]) => name),
    servicesConfig,
    reposConfig,
    (meta["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter((s) => s),
    archetypes,
  );
  let routers: Record<string, FeatureRouter> = {};
  try {
    routers = loadFeatureRouters(servicesConfig);
  } catch {
    routers = {};
  }
  const testerSpecs = buildTesterSpecs(
    present,
    servicesConfig,
    archetypes,
    (meta["FEATURE"] ?? "").trim(),
    routers,
    (meta["TEST_PATH"] ?? "").trim(),
  );
  for (const agentPath of writeWorkspaceAgents(workspaceRoot, testerSpecs)) {
    success(`Wrote ${agentPath}`);
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/sandbox-core && npm test && cd ../../apps/cli && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/agent_gen.ts packages/sandbox-core/workspace_init.ts packages/sandbox-core/agent-gen.test.mjs
git commit -m "feat(core): tester runs the proxy smoke check; researcher carries the method

The tester agent is the one generated artifact with Bash, so it owns
'verify the running feature through Caddy' — a step starting prompts ask for
that no phase owned. The investigation method moves from the sb-research
skill (main-agent context) into the sb-researcher agent that investigates.
Both agents drop 'read CLAUDE.md first' — Claude Code injects it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Thin the entry skills

**Files:**
- Modify: `apps/cli/infra/skills/sb-research/SKILL.md` (rewrite)
- Modify: `apps/cli/infra/skills/sb-test/SKILL.md:8-12`, `:20-24`
- Modify: `apps/cli/infra/skills/sb-implement/SKILL.md:15-19`, `:53-79`

**Interfaces:** none (markdown). `sandbox skills check` is the gate; Task 8 runs it.

- [ ] **Step 1: Rewrite `sb-research/SKILL.md`**

Replace the whole file with:

````md
---
name: sb-research
description: "Begin the research/planning phase in a sandbox workspace. Use when exploring the codebase, investigating a bug, or planning an approach — any read-only work BEFORE code will be written or edited."
---

# sb-research — enter the research phase

- **Step 0 — read the workspace notes.** List `.sandbox/notes/` and read the `finding`
  and `attempt` notes relevant to the task (skip `status: superseded`). Do **not**
  re-research a question a `finding` answers or re-try an approach an `attempt` records
  as failed. Missing or empty directory → continue.
- Do **not** load any code standards (`sb-*-standard` skills, `ponytail`) — they govern
  writing code, and this phase is read-only.
- **Establish scope before spawning.** Settle these with the user (AskUserQuestion) when
  the task leaves them ambiguous — a wrong scope assumption compounds through everything
  downstream, and an unscoped agent silently expands its own mandate:
  - **In scope vs. out** — which repos/services may be touched vs. treated as fixed.
  - **Spike or ship-ready** — a throwaway feasibility spike and a design meant to be built
    demand different depth.
  - **The givens** — settled assumptions to hold constant. A workspace `decision` note is
    a given, and it is binding.
  - **Deliverable shape** — options analysis (default), ADR, or research story.
- **Spawn the workspace's `sb-researcher` agent** (`.claude/agents/sb-researcher.md`)
  with the task, the scope, the givens, and the deliverable shape in its prompt. It
  carries the investigation method, cannot touch source files by construction, and
  writes its findings to `.sandbox/notes/NNN-finding-*.md`, returning a short summary
  plus the note path. If the agent is not available (a workspace generated before it
  existed), do the research inline under the same rules — read, search, and reason only —
  and write the same `finding` note yourself.
- **Read what you reason against.** Delegation buys window space with a layer of
  indirection. Delegate broad searches whose file dumps are throwaway ("who imports X");
  read inline anything a correctness claim will rest on (`decision` notes, the function
  whose behaviour is your safety argument); verify a delegated conclusion firsthand before
  it becomes load-bearing for shipped code.
- Relay the researcher's summary **and the note path**, then put its OPEN QUESTIONS /
  AMBIGUITIES to the user (AskUserQuestion) and let them resolve those **before**
  proposing or starting the next phase.

## Exit

When the task turns into writing code, invoke `sb-implement` first — it loads the
universal coding base and the matching domain standards before the first edit.
````

Check: `wc -c apps/cli/infra/skills/sb-research/SKILL.md` — expected under 2600.

- [ ] **Step 2: Edit `sb-test/SKILL.md`**

Replace, in Step 0:

```
  to. When in doubt, `.sandbox/service-map.md` maps repos to services.
```

with:

```
  to. When in doubt, the Services table in `.sandbox/sandbox-context.md` maps services
  to repos and paths.
```

Replace, in the Fallback bullet:

```
  no tester): run the tests inline under the same rules — the test command comes from
  services.yaml via `.sandbox/service-map.md` or the repo's `package.json`; edit only
```

with:

```
  no tester): run the tests inline under the same rules — the test command is the
  service's `test:` in `~/.sandbox/services.yaml` (or its archetype's) or the repo's
  `package.json`; edit only
```

Insert after the **Spawn** bullet (before **Fallback**):

```
- **Verifying the running feature.** The tester agents run a proxy smoke check (curl
  through Caddy with the `X-Feature` cookie) when the containers are up. For a headed
  browser session against the feature URL, use the `sandbox-tools:sandbox-feature-test`
  plugin skill; the URL and cookie are in `.sandbox/sandbox-context.md`.
```

- [ ] **Step 3: Edit `sb-implement/SKILL.md`**

Replace the `ponytail` bullet (lines 15-19):

```
   - `ponytail` — the decision ladder (does this need to exist? already in the codebase?
     stdlib first? simplest thing that works). If it isn't installed, say so once and
     continue.
```

Replace the whole `## Keep verbose checks out of the dead middle` section (through the closing `-->` of the ponytail comment) with:

````md
## Keep verbose checks out of the dead middle

Redirect any check that dumps a lot of output — a test suite, a build, a typecheck —
to a file and read back only the failures; a full dump buries the standards you loaded
at phase entry under thousands of low-signal tokens:

    npm test > /tmp/check.log 2>&1; echo "exit=$?"
    grep -nE '✖|✗|×|npm error|Tests.*failed' /tmp/check.log   # only if exit was non-zero

Trust the exit code (zero needs no grep) and match the runners' failure glyphs, not the
word "fail" — a loose `-i 'fail|error'` matched 158 lines on a passing run of this
monorepo's suite.

<!-- ponytail: phase-entry placement drifts to the low-attention middle by mid-session;
     no command-time hook re-injects it. Recitation (step 6) is the re-anchor. -->
````

- [ ] **Step 4: Verify sizes**

Run: `wc -c apps/cli/infra/skills/sb-research/SKILL.md apps/cli/infra/skills/sb-implement/SKILL.md`
Expected: sb-research < 2600, sb-implement < 4600.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/infra/skills/sb-research/SKILL.md apps/cli/infra/skills/sb-test/SKILL.md apps/cli/infra/skills/sb-implement/SKILL.md
git commit -m "refactor(skills): thin sb-research to a dispatcher; trim sb-implement and sb-test

sb-research loaded 5KB of investigation method into the main agent while the
researcher subagent got none; the method now lives in the agent. sb-test names
the proxy smoke check and the browser path. sb-implement keeps the rule and
drops the essay.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Update `docs/jit-context-system.md`

**Files:**
- Modify: `docs/jit-context-system.md` §5 (line 203-209), §5.2 table (237, 238), §5.3 (244-254), §5.4 (261-267), §5.7 (334-337), §8 (419-428)

- [ ] **Step 1: §5 — projection scope**

After the sentence ending "The `sandbox-tools` plugin keeps only the globally useful `sandbox-*` ops skills." add:

```
Standards skills are projected only for the workspace's active set (§4.1): a skill that
is not there cannot be loaded, so the routing table carries no "do not load" list.
```

- [ ] **Step 2: §5.2 table rows**

Replace the `sb-research` row's third column with:

```
loads nothing; establishes scope, givens and deliverable shape with the user; spawns the read-only `sb-researcher` agent, which carries the investigation method
```

Replace the `sb-test` row's third column with:

```
loads nothing; spawns `sb-tester-<archetype>` agent(s), which run the unit tests and a guarded proxy smoke check; names the plugin's `sandbox-feature-test` skill for headed browser runs
```

- [ ] **Step 3: §5.3 — routing table shape**

Replace the first paragraph of §5.3 with:

```
`apps/cli/src/lib/claude_md.ts::buildStandardsRoutingSection`. The "Standards routing" section
contains the Active table (`| Standard | Skill | Loads on |`, where "Loads on" = `applies_to`
globs or "any code edit") and the by-phase table (`| Phase | Invoke first | Loads |`), which is
the only statement of the phase chain. The rest of the file is Current Task, Layout, the
two-column Routing table (a repo's own `CLAUDE.md` when it exists; `.sandbox/sandbox-context.md`
for everything about the running feature — URL, `X-Feature` cookie, ports, lifecycle, health
checks; `contract` notes for multi-repo workspaces), the Context Budget rule (≤3 files/step), and
the Notes pointer. `.sandbox/sandbox-context.md` is written by the compose generator and is
scoped to the workspace: through-Caddy health checks only for its local services' hosts, the
feature URL and browser cookie, and a Services table carrying each service's path in its repo.
```

Keep the second paragraph ("The `CLAUDE.md` is a **compiled projection** …") as is.

- [ ] **Step 4: §5.4 — agent bodies**

Append to the `sb-researcher` bullet:

```
  Its body carries the investigation method (present options, tag claims
  verified/inferred/assumed, hold givens, bound the investigation, validate against named
  standards, deliverable shape): the method loads in the subagent that investigates, not in
  the main agent that dispatches.
```

Append to the `sb-tester-<archetype>` bullet, after "pointers to its standards.":

```
  For each service with a `feature_router:` host it also carries a guarded proxy smoke
  check — a `docker ps` guard, then `curl` through Caddy with the `X-Feature` cookie —
  reported SKIPPED when the container is not running; the tester never starts containers.
```

Delete the sentence "Workspace context: read CLAUDE.md first" if it appears anywhere in the doc (it does not today; this is a check).

- [ ] **Step 5: §5.7 — seeding**

Replace:

```
naturally. Seeding is write-once: only while the workspace has no handoff note of any status.
```

with:

```
naturally. Seeding happens only when a prompt exists; a placeholder handoff written by an
older CLI (author `workspace-creation`, no prompt) is superseded by the next init that has
one. Any other handoff note blocks re-seeding.
```

- [ ] **Step 6: §8 — cost profile**

After the `sb-implement` entry line add:

```
- `sb-research` entry: ~0.7k tokens (thin dispatcher; the method lives in the subagent).
```

- [ ] **Step 7: Commit**

```bash
git add docs/jit-context-system.md
git commit -m "docs: jit-context-system reflects the trimmed workspace projection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification on the `test` workspace

**Files:** none modified in this repo. Touches `~/features/test` (regenerates its projections, rebuilds its Docker images).

- [ ] **Step 1: Build the CLI**

Run: `cd /Users/jayboyer/repos/sandbox && npm run build`
Expected: turbo builds `sandbox-core` and `cli` with no errors.

- [ ] **Step 2: Re-init the workspace**

Run: `cd /Users/jayboyer/features/test && sandbox init-workspace`
Expected: `Seeded starting handoff → .sandbox/notes/002-handoff-starting-prompt.md`; no `Wrote .sandbox/service-map.md`; skill writes list only `sb-comments-standard`, `sb-engineering-standard`, `sb-config-standard`, `sb-testing-standard`, `sb-ui-standard` plus the seven entry skills.

- [ ] **Step 3: Check the artifacts**

```bash
cd /Users/jayboyer/features/test
grep -c "Feature Testing" CLAUDE.md                 # 0
grep -c "Not active" CLAUDE.md                      # 0
grep -c "Phase entry" CLAUDE.md                     # 0
ls .claude/skills                                   # no sb-auth/-data/-observability/-service-standard
grep status .sandbox/notes/001-handoff-starting-prompt.md   # status: superseded
grep -c "Acceptance criteria" .sandbox/notes/002-handoff-starting-prompt.md   # 1
grep "PROXY SMOKE CHECK" -A 6 .claude/agents/sb-tester-node-web.md   # guard + curl for frontend
grep -c 'curl -sk -b "X-Feature=test"' .sandbox/sandbox-context.md    # 1
grep -c "## Infrastructure" .sandbox/sandbox-context.md               # 0
grep "Feature URL" .sandbox/sandbox-context.md      # https://frontend.local.sandbox.com/
grep -c "read CLAUDE.md first" .claude/agents/*.md  # 0 for both
wc -c CLAUDE.md .claude/skills/sb-research/SKILL.md # < 2500 each
```

- [ ] **Step 4: Check the freshness and re-injection commands**

```bash
cd /Users/jayboyer/features/test
sandbox skills check          # "Workspace sb-* skills are current."
sandbox notes context | head -30   # latest handoff is 002 and shows the real prompt
```

- [ ] **Step 5: Run the full suites once more**

Run: `cd /Users/jayboyer/repos/sandbox && npm test`
Expected: all packages pass.

- [ ] **Step 6: Record the result**

If everything above matched, append `**Status: done**` under the plan title and commit:

```bash
git add docs/superpowers/plans/2026-09-26-workspace-context-trim.md
git commit -m "docs: mark the workspace context trim plan done

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

If a check did not match, fix it in the task that owns that artifact and rerun from Step 1.
