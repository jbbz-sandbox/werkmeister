# Workspace Create Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every workspace create (CLI, MCP, pane, skills; JIT and ICM) goes through one core function that stores the issue verbatim in the workspace and renders the same issue section in both strategies; `sandbox connect` checks tracker sign-in.

**Architecture:** `createWorkspace` in `packages/sandbox-core/sandbox.ts` gains a `prepareCreate` step (resolve inputs → fetch issue snapshot, failing the create → optional distill of empty fields) before `provisionWorkspace`. `initWorkspace` writes/reads `.sandbox/issue.md` and passes an `IssueRef` to the strategy; a shared `renderIssueRef` renders it in ICM (`CLAUDE.md`, `BRIEF.md`) and JIT (`CLAUDE.md`, starting handoff). Trackers gain `checkAuth()`, used by `connect`, the pane and create's error text.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, `node:test` for `packages/sandbox-core` (`*.test.mjs` against `dist/`, run `npm run build` first), vitest for `apps/cli`, the plugin test runner for `plugins/sandbox-tools` (`claude plugin test`).

**Spec:** `docs/superpowers/specs/2026-10-11-workspace-create-pipeline-design.md`

## Global Constraints

- Issue copy path: `.sandbox/issue.md`; frontmatter keys exactly `ref`, `url`, `tracker`, `status`, `fetched`.
- Re-read instruction text exactly: ``Before each stage, re-read the live issue for newer direction: `sandbox issue view` ``.
- A fetch failure for a set `issue_id` fails the create before any worktree or directory is made.
- Distill fills only empty fields; it never overwrites a caller-supplied value; its failure is a warning.
- `BRIEF.md` stays write-once, except a brief that is still exactly the placeholder is rebuilt.
- Workspaces without an issue render byte-identically to today.
- `checkAuth` failure never fails `sandbox connect`.
- Credentials are only ever typed into the tracker's own prompt (`gh auth login`); sandbox never reads or stores them.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Issue body/comments containing `---` lines or Markdown headings must not break `parseIssueCopy` (only the first frontmatter block is metadata). → Task 1 test "body with --- and headings round-trips".
2. A ref given as a URL (`https://github.com/o/r/issues/5`) or short form must be normalised before the dir name and the copy are made. → Task 4 test "URL ref is normalised".
3. Re-running `init-workspace` (no refresh) on a workspace created before this change (no `issue.md`) must not fail and must render the no-copy section. → Task 3 test "missing copy renders the no-copy section".
4. A multi-line distilled `description` must not corrupt `.env`. → Task 3 test "multi-line DESCRIPTION is one .env line".
5. `--refresh-issue` on a workspace with no `issue_id` must fail with a clear message and change nothing. → Task 3 test "refresh without issue_id fails cleanly".

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/sandbox-core/issue_snapshot.ts` (new) | `IssueSnapshot` type, `fetchIssueSnapshot`, `renderIssueCopy`, `parseIssueCopy`, `writeIssueCopy`, `readIssueRef` |
| `packages/sandbox-core/strategies/issue_section.ts` (new) | `renderIssueRef(issue)` — the one issue section both strategies print |
| `packages/sandbox-core/strategies/types.ts` | `IssueRef` type; `InitContext.issue` |
| `packages/sandbox-core/strategies/icm.ts` | issue section in `CLAUDE.md`, new `renderBrief`, placeholder-brief rebuild |
| `packages/sandbox-core/strategies/jit.ts`, `claude_md.ts` | issue section in `CLAUDE.md` and the starting handoff |
| `packages/sandbox-core/workspace_init.ts` | write/refresh/read the copy; pass `issue` to the strategy |
| `packages/sandbox-core/generate.ts` | single-line `.env` metadata values |
| `packages/sandbox-core/sandbox.ts` | `prepareCreate`, `distillIssue`, `createWorkspace` options |
| `packages/sandbox-core/issue_trackers/{types,github,jira}.ts`, `jira-rest.ts`, `machine_setup.ts` | `checkAuth`, Jira placeholder handling, `SANDBOX_GH_BIN` seam |
| `apps/cli/src/commands/{workspace,connect,init_workspace}.ts`, `apps/cli/src/lib/wizard.ts`, `apps/cli/src/main.ts` | CLI through `createWorkspace`, `--no-distill`, `--refresh-issue`, wizard issue step, connect tracker line, browser-form prefill |
| `apps/sandbox-dashboard/form-cli.ts` | `--prefill <json>` |
| `plugins/sandbox-tools/hooks/register.tsx` (+ types, test) | Create distils on the session model, then `distill:false`; tracker on the infra line |
| `plugins/sandbox-tools/skills/sandbox-workspace/SKILL.md`, MCP descriptions, docs | one entry point in the instructions |
| `packages/sandbox-core/create-entry-guard.test.mjs` (new) | fails if apps/plugins call `provisionWorkspace` |

---

### Task 1: Issue snapshot module and fake `gh`

**Files:**
- Create: `packages/sandbox-core/issue_snapshot.ts`
- Modify: `packages/sandbox-core/issue_trackers/github.ts` (the `gh()` helper, ~line 54)
- Modify: `packages/sandbox-core/fixtures.mjs` (add `withFakeGh`)
- Test: `packages/sandbox-core/issue-snapshot.test.mjs` (new)

**Interfaces:**
- Produces:
  - `interface IssueSnapshot { ref: string; url: string | null; tracker: TrackerId; title: string; status: string; body: string; comments: IssueComment[]; fetchedAt: string }`
  - `class IssueFetchError extends Error`
  - `fetchIssueSnapshot(ref: string, now?: () => Date): Promise<IssueSnapshot>` — throws `IssueFetchError`
  - `renderIssueCopy(s: IssueSnapshot): string`, `parseIssueCopy(text: string): IssueSnapshot | null`
  - `ISSUE_COPY = ".sandbox/issue.md"`, `writeIssueCopy(root: string, s: IssueSnapshot): void`
  - `readIssueRef(root: string, issueId: string): IssueRef | null` (uses the copy, else a no-copy ref from `issueId`, else null)
  - `fixtures.mjs`: `withFakeGh({ issue, auth = 0, repoView = 0 }, fn)`

- [ ] **Step 1: Add the `SANDBOX_GH_BIN` seam** in `issue_trackers/github.ts`. `childEnv()` puts `/opt/homebrew/bin` ahead of `$PATH`, so a PATH shim can't shadow a real `gh`; tests need an explicit binary:

```ts
/** `gh`, or $SANDBOX_GH_BIN (tests point it at a fake). */
const ghBin = () => process.env.SANDBOX_GH_BIN || "gh";

async function gh(args: string[]): Promise<string> {
  const r = await runAsync([ghBin(), ...args], { capture: true, env: childEnv(), timeout: 30 });
  if (r.status !== 0) throw new Error(r.stderr.trim() || `gh ${args[0]} ${args[1]} exited ${r.status}`);
  return r.stdout;
}
```
Export `ghBin` (Task 6 uses it).

- [ ] **Step 2: Add `withFakeGh` to `fixtures.mjs`**

```js
/**
 * Run *fn* with $SANDBOX_GH_BIN pointing at a fake `gh`: `issue view` prints
 * `issue` as JSON (exit 1 when null), `auth status` exits `auth`, `repo view` exits `repoView`.
 */
export async function withFakeGh({ issue = null, auth = 0, repoView = 0 } = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-"));
  fs.writeFileSync(path.join(dir, "issue.json"), JSON.stringify(issue));
  const bin = path.join(dir, "gh");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
case "$1 $2" in
  "issue view") if [ "$(cat '${dir}/issue.json')" = "null" ]; then echo "could not resolve" >&2; exit 1; fi; cat '${dir}/issue.json';;
  "auth status") if [ ${auth} = 0 ]; then echo "  ✓ Logged in to github.com account octo (keyring)" >&2; else echo "You are not logged into any GitHub hosts." >&2; fi; exit ${auth};;
  "repo view") exit ${repoView};;
  *) exit 0;;
esac
`,
    { mode: 0o755 },
  );
  const prev = process.env.SANDBOX_GH_BIN;
  process.env.SANDBOX_GH_BIN = bin;
  try {
    return await fn(bin);
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_GH_BIN;
    else process.env.SANDBOX_GH_BIN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: Write the failing tests** `packages/sandbox-core/issue-snapshot.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withFakeGh, withSandboxHome } from "./fixtures.mjs";
import {
  IssueFetchError, fetchIssueSnapshot, parseIssueCopy, readIssueRef, renderIssueCopy, writeIssueCopy,
} from "./dist/issue_snapshot.js";

const GH = "overrides:\n  issue_tracker: github\n";
const ISSUE = {
  title: "Stale config survives up",
  state: "OPEN",
  body: "Ran it.\n\n---\n\n## Expected\nGone.",
  url: "https://github.com/o/r/issues/5",
  labels: [{ name: "bug" }],
  assignees: [],
  comments: [{ author: { login: "amy" }, createdAt: "2026-10-02T10:00:00Z", body: "Still there." }],
};
const NOW = () => new Date("2026-10-11T18:04:00Z");

test("fetchIssueSnapshot keeps the body and every comment", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const s = await fetchIssueSnapshot("o/r#5", NOW);
      assert.deepEqual(s, {
        ref: "o/r#5", url: "https://github.com/o/r/issues/5", tracker: "github",
        title: "Stale config survives up", status: "Open", body: ISSUE.body,
        comments: [{ author: "amy", created: "2026-10-02T10:00:00Z", body: "Still there." }],
        fetchedAt: "2026-10-11T18:04:00.000Z",
      });
    });
  }, { config: GH });
});

test("fetchIssueSnapshot throws IssueFetchError when the tracker can't read it", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: null }, async () => {
      await assert.rejects(fetchIssueSnapshot("o/r#5", NOW), IssueFetchError);
    });
  }, { config: GH });
});

test("body with --- and headings round-trips", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const s = await fetchIssueSnapshot("o/r#5", NOW);
      const text = renderIssueCopy(s);
      assert.match(text, /^---\nref: o\/r#5\nurl: https:\/\/github.com\/o\/r\/issues\/5\ntracker: github\nstatus: Open\nfetched: 2026-10-11T18:04:00.000Z\n---\n\n# Stale config survives up\n/);
      assert.match(text, /\n## Comments\n\n### amy · 2026-10-02T10:00:00Z\n\nStill there.\n$/);
      assert.deepEqual(parseIssueCopy(text), s);
    });
  }, { config: GH });
});

test("readIssueRef: copy, else a no-copy ref from issue_id, else null", async () => {
  await withSandboxHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    assert.equal(readIssueRef(root, ""), null);
    assert.deepEqual(readIssueRef(root, "o/r#5"), {
      ref: "o/r#5", url: "https://github.com/o/r/issues/5", title: "", fetchedAt: null,
    });
    await withFakeGh({ issue: ISSUE }, async () => writeIssueCopy(root, await fetchIssueSnapshot("o/r#5", NOW)));
    assert.deepEqual(readIssueRef(root, "o/r#5"), {
      ref: "o/r#5", url: "https://github.com/o/r/issues/5", title: "Stale config survives up",
      fetchedAt: "2026-10-11T18:04:00.000Z",
    });
  }, { config: GH });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd packages/sandbox-core && npm run build && node --test issue-snapshot.test.mjs`
Expected: FAIL — `Cannot find module './dist/issue_snapshot.js'`.

- [ ] **Step 5: Implement `packages/sandbox-core/issue_snapshot.ts`**

The copy round-trips without YAML or JSON in the body: the frontmatter is five fixed `key: value` lines, the renderer always writes a `## Comments` heading last, and the parser splits at the **last** such heading, so `---` lines or headings inside the body don't confuse it. (Ceiling: a comment whose own text contains a blank line followed by `## Comments` would mis-split; acceptable for a generated file, noted with a `ponytail:` comment.)

```ts
/**
 * The workspace's own copy of its issue (`.sandbox/issue.md`): fetched once at
 * creation, refreshed only by `sandbox init-workspace --refresh-issue`. The
 * source of record the brief and CLAUDE.md point at (docs/context-strategies.md).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { issueTracker, type IssueComment, type TrackerId } from "./issue_tracker.js";
import type { IssueRef } from "./strategies/types.js";

export const ISSUE_COPY = ".sandbox/issue.md";

export interface IssueSnapshot {
  ref: string;
  url: string | null;
  tracker: TrackerId;
  title: string;
  status: string;
  body: string;
  comments: IssueComment[];
  /** ISO time the copy was taken. */
  fetchedAt: string;
}

export class IssueFetchError extends Error {}

export async function fetchIssueSnapshot(ref: string, now: () => Date = () => new Date()): Promise<IssueSnapshot> {
  const tracker = issueTracker();
  const issue = await tracker.fetchIssue(ref);
  if (!issue) throw new IssueFetchError(`couldn't read ${ref} from ${tracker.label}`);
  return {
    ref: issue.ref,
    url: issue.url ?? tracker.url(issue.ref),
    tracker: tracker.id,
    title: issue.title ?? "",
    status: issue.status ?? "",
    body: issue.description ?? "",
    comments: issue.comments ?? [],
    fetchedAt: now().toISOString(),
  };
}

const COMMENTS = "\n\n## Comments\n";

export function renderIssueCopy(s: IssueSnapshot): string {
  const head = [
    "---",
    `ref: ${s.ref}`,
    `url: ${s.url ?? ""}`,
    `tracker: ${s.tracker}`,
    `status: ${s.status}`,
    `fetched: ${s.fetchedAt}`,
    "---",
    "",
    `# ${s.title}`,
    "",
    s.body,
  ].join("\n");
  const comments = s.comments.map((c) => `\n### ${c.author} · ${c.created ?? ""}\n\n${c.body}\n`).join("");
  return `${head}${COMMENTS}${comments}`;
}

export function parseIssueCopy(text: string): IssueSnapshot | null {
  const m = /^---\nref: (.*)\nurl: (.*)\ntracker: (.*)\nstatus: (.*)\nfetched: (.*)\n---\n\n# (.*)\n\n/.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  // The renderer always writes the Comments heading last-but-blocks; take the final one.
  // ponytail: splits at the last Comments heading; a comment quoting "\n\n## Comments\n" would mis-split.
  const at = rest.lastIndexOf(COMMENTS);
  if (at < 0) return null;
  const blocks = rest.slice(at + COMMENTS.length);
  const comments: IssueComment[] = [];
  for (const b of blocks.split(/\n(?=### )/).filter((x) => x.trim())) {
    const c = /^\n?### (.*) · (.*)\n\n([\s\S]*?)\n?$/.exec(b);
    if (!c) return null;
    comments.push({ author: c[1], ...(c[2] ? { created: c[2] } : {}), body: c[3] });
  }
  return {
    ref: m[1], url: m[2] || null, tracker: m[3] as TrackerId, status: m[4], fetchedAt: m[5],
    title: m[6], body: rest.slice(0, at), comments,
  };
}

export function writeIssueCopy(root: string, s: IssueSnapshot): void {
  const p = path.join(root, ISSUE_COPY);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderIssueCopy(s));
}

/** What the strategies render: the stored copy, else a no-copy ref built from `issueId`, else null. */
export function readIssueRef(root: string, issueId: string): IssueRef | null {
  let s: IssueSnapshot | null = null;
  try {
    s = parseIssueCopy(fs.readFileSync(path.join(root, ISSUE_COPY), "utf8"));
  } catch {
    /* no copy */
  }
  if (s) return { ref: s.ref, url: s.url, title: s.title, fetchedAt: s.fetchedAt };
  if (!issueId) return null;
  return { ref: issueId, url: issueTracker().url(issueId), title: "", fetchedAt: null };
}
```

Add `IssueRef` to `strategies/types.ts` now (Task 2 uses it too):

```ts
/** The workspace's issue as the context layer renders it; `fetchedAt` null = no stored copy. */
export interface IssueRef {
  ref: string;
  url: string | null;
  title: string;
  fetchedAt: string | null;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `cd packages/sandbox-core && npm run build && node --test issue-snapshot.test.mjs`
Expected: 4 pass. If "body with --- and headings" fails on the comments regex, the fix belongs in `parseIssueCopy`, not the test.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/issue_snapshot.ts packages/sandbox-core/strategies/types.ts packages/sandbox-core/issue_trackers/github.ts packages/sandbox-core/fixtures.mjs packages/sandbox-core/issue-snapshot.test.mjs
git commit -m "feat(core): issue snapshot — the workspace's own copy of its issue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared issue section, ICM rendering

**Files:**
- Create: `packages/sandbox-core/strategies/issue_section.ts`
- Modify: `packages/sandbox-core/strategies/types.ts` (`InitContext.issue`)
- Modify: `packages/sandbox-core/strategies/icm.ts` (`renderClaudeMd` ~143, `renderBrief` ~203, `init` ~274, `contextFromDisk` ~238)
- Test: `packages/sandbox-core/strategy-icm-init.test.mjs`, new `packages/sandbox-core/issue-section.test.mjs`

**Interfaces:**
- Consumes: `IssueRef` (Task 1).
- Produces: `renderIssueRef(issue: IssueRef): string`; `InitContext.issue?: IssueRef | null`; exported `PLACEHOLDER_BRIEF_RE` from `icm.ts`.

- [ ] **Step 1: Write the failing tests** — `issue-section.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderIssueRef } from "./dist/strategies/issue_section.js";

test("renderIssueRef with a stored copy", () => {
  assert.equal(
    renderIssueRef({ ref: "o/r#5", url: "https://github.com/o/r/issues/5", title: "Stale config", fetchedAt: "2026-10-11T18:04:00.000Z" }),
    "## Issue\n\n[o/r#5](https://github.com/o/r/issues/5): Stale config. Copy taken 2026-10-11: `.sandbox/issue.md`.\n" +
      "Before each stage, re-read the live issue for newer direction: `sandbox issue view`\n",
  );
});

test("renderIssueRef without a copy or url (Jira, no base_url)", () => {
  assert.equal(
    renderIssueRef({ ref: "PROJ-12", url: null, title: "", fetchedAt: null }),
    "## Issue\n\nPROJ-12. No stored copy; run `sandbox init-workspace --refresh-issue`.\n" +
      "Before each stage, re-read the live issue for newer direction: `sandbox issue view`\n",
  );
});
```

Append to `strategy-icm-init.test.mjs` (uses its `withIcmWorkspace` and `icm` helpers):

```js
const ISSUE = { ref: "o/r#5", url: "https://github.com/o/r/issues/5", title: "Stale config", fetchedAt: "2026-10-11T18:04:00.000Z" };

test("an issue puts the issue section in CLAUDE.md and BRIEF.md", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init({ ...ctx, issue: ISSUE });
    const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    assert.match(claude, /\n## Issue\n\n\[o\/r#5\]\(https:\/\/github.com\/o\/r\/issues\/5\): Stale config\./);
    assert.match(claude, /\| `\.sandbox\/issue\.md` \| the issue as fetched at creation; refresh with `sandbox init-workspace --refresh-issue` \|/);
    const brief = fs.readFileSync(path.join(root, "BRIEF.md"), "utf8");
    assert.match(brief, /^---\nsource: \.sandbox\/workspace\.yml \(description, starting_prompt\), \.sandbox\/issue\.md\n---\n\n# Brief: /);
    assert.match(brief, /## Issue\n[\s\S]*Fix the thing\.\n\n## Goal/);
    assert.doesNotMatch(brief, /No starting prompt was given/);
  }, { inputs: { description: "Fix the thing.", starting_prompt: "## Goal\n\nGone." } });
});

test("an issue with no description or prompt tells the agent to read the copy", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init({ ...ctx, issue: ISSUE });
    assert.match(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8"),
      /_Read `\.sandbox\/issue\.md`, then write the goal, acceptance criteria and open questions here before starting the first stage\._/);
  }, { inputs: { starting_prompt: "" } });
});

test("a placeholder brief is rebuilt once an issue exists; an edited brief is kept", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init(ctx); // placeholder brief, as the 2026-10-11 workspaces got
    icm.init({ ...ctx, issue: ISSUE });
    assert.match(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8"), /## Issue/);
    fs.writeFileSync(path.join(root, "BRIEF.md"), "hand edit\n");
    icm.init({ ...ctx, issue: ISSUE });
    assert.equal(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8"), "hand edit\n");
  }, { inputs: { starting_prompt: "" } });
});

test("no issue: CLAUDE.md and BRIEF.md are unchanged from before", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init({ ...ctx, issue: null });
    const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    assert.doesNotMatch(claude, /## Issue|issue\.md/);
    assert.match(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8"), /^---\nsource: \.sandbox\/workspace\.yml \(starting_prompt\)\n---/);
  });
});

test("same context twice gives byte-identical files", async () => {
  const snap = async (ctxPatch) => {
    let files;
    await withIcmWorkspace(async (root, ctx) => {
      icm.init({ ...ctx, ...ctxPatch, issue: ISSUE });
      files = Object.fromEntries(walk(root).filter((f) => !f.startsWith("demo-repo")).map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]));
    }, { inputs: { starting_prompt: "## Goal\n\nGone." } });
    return files;
  };
  assert.deepEqual(await snap({}), await snap({}));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sandbox-core && npm run build && node --test issue-section.test.mjs strategy-icm-init.test.mjs`
Expected: FAIL — module `issue_section.js` missing; ICM tests fail on missing `## Issue`.

- [ ] **Step 3: Implement**

`strategies/issue_section.ts`:

```ts
/** The issue section both strategies print: same words, same place in each file. */
import type { IssueRef } from "./types.js";

export function renderIssueRef(issue: IssueRef): string {
  const name = issue.url ? `[${issue.ref}](${issue.url})` : issue.ref;
  const title = issue.title ? `: ${issue.title}` : "";
  const copy = issue.fetchedAt
    ? `Copy taken ${issue.fetchedAt.slice(0, 10)}: \`.sandbox/issue.md\`.`
    : "No stored copy; run `sandbox init-workspace --refresh-issue`.";
  return [
    "## Issue",
    "",
    `${name}${title}. ${copy}`,
    "Before each stage, re-read the live issue for newer direction: `sandbox issue view`",
    "",
  ].join("\n");
}
```

`strategies/types.ts` — add to `InitContext`:

```ts
  /** The workspace's issue (`.sandbox/issue.md`, else just `issue_id`); null/absent when it has none. */
  issue?: IssueRef | null;
```

`strategies/icm.ts`:

```ts
import { renderIssueRef } from "./issue_section.js";
```

In `renderClaudeMd`, after `ctx.task, "",` insert `...(ctx.issue ? [renderIssueRef(ctx.issue)] : []),` and after the `BRIEF.md` table row insert:

```ts
    ...(ctx.issue ? ["| `.sandbox/issue.md` | the issue as fetched at creation; refresh with `sandbox init-workspace --refresh-issue` |"] : []),
```

Replace `renderBrief`:

```ts
const NO_PROMPT =
  "_No starting prompt was given. Write the goal, acceptance criteria and open questions here before starting the first stage._";
const READ_ISSUE =
  "_Read `.sandbox/issue.md`, then write the goal, acceptance criteria and open questions here before starting the first stage._";

/** A brief nobody has touched: what renderBrief wrote with no issue and no prompt. */
export const PLACEHOLDER_BRIEF_RE = /^---\nsource: \.sandbox\/workspace\.yml \(starting_prompt\)\n---\n\n# Brief: [^\n]*\n\n_No starting prompt was given\. [^\n]*_\n$/;

function renderBrief(ctx: InitContext): string {
  const prompt = (ctx.inputs["starting_prompt"] ?? "").trim();
  if (!ctx.issue) {
    // Unchanged from before the issue copy existed.
    return ["---", "source: .sandbox/workspace.yml (starting_prompt)", "---", "", `# Brief: ${ctx.task}`, "", prompt || NO_PROMPT, ""].join("\n");
  }
  const description = (ctx.inputs["description"] ?? "").trim();
  return [
    "---",
    "source: .sandbox/workspace.yml (description, starting_prompt), .sandbox/issue.md",
    "---",
    "",
    `# Brief: ${ctx.task}`,
    "",
    renderIssueRef(ctx.issue),
    ...(description ? [description, ""] : []),
    ...(prompt ? [prompt, ""] : []),
    ...(!description && !prompt ? [READ_ISSUE, ""] : []),
  ].join("\n");
}
```

In `init`, replace the BRIEF guard:

```ts
  // The brief is the operator's once written — same rule as seedStartingHandoff —
  // except an untouched placeholder, rebuilt once there is an issue to brief from.
  const briefPath = path.join(root, "BRIEF.md");
  const existing = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, "utf8") : null;
  if (existing === null || (ctx.issue && PLACEHOLDER_BRIEF_RE.test(existing))) {
    files["BRIEF.md"] = renderBrief(ctx);
  }
```

`contextFromDisk` needs no issue (CLAUDE.md and BRIEF.md are not in `render`).

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/sandbox-core && npm run build && node --test issue-section.test.mjs strategy-icm-*.test.mjs`
Expected: all pass, including the existing "an empty starting prompt still gives the brief a body".

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/strategies packages/sandbox-core/issue-section.test.mjs packages/sandbox-core/strategy-icm-init.test.mjs
git commit -m "feat(icm): issue section in CLAUDE.md and BRIEF.md; rebuild placeholder briefs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: JIT rendering, `initWorkspace` copy handling, `.env` values

**Files:**
- Modify: `packages/sandbox-core/claude_md.ts` (`buildClaudeMd` ~204, Current Task ~246)
- Modify: `packages/sandbox-core/strategies/jit.ts` (`seedStartingHandoff` ~106, call ~200)
- Modify: `packages/sandbox-core/workspace_init.ts` (`InitWorkspaceOptions` ~90, `initWorkspace` after step 2a ~647, `strategy.init` call ~696)
- Modify: `packages/sandbox-core/generate.ts:285-290`
- Modify: `apps/cli/src/main.ts` (`init-workspace` options + namespace), `apps/cli/src/commands/init_workspace.ts` (pass `refresh_issue`)
- Test: `packages/sandbox-core/claude-md.test.mjs`, `workspace-init-seed.test.mjs`, new `workspace-init-issue.test.mjs`

**Interfaces:**
- Consumes: `renderIssueRef`, `IssueRef`, `IssueSnapshot`, `writeIssueCopy`, `readIssueRef`, `fetchIssueSnapshot`, `IssueFetchError`.
- Produces: `InitWorkspaceOptions.issue?: IssueSnapshot`; `initWorkspace` arg `refresh_issue: boolean`; exported `resolveIssueCopy(root: string, issueId: string, opts: { issue?: IssueSnapshot; refresh?: boolean }): Promise<IssueRef | null>`; `buildClaudeMd(..., standardsSection, issue: IssueRef | null = null)`; `seedStartingHandoff(root, prompt, workType, issue: IssueRef | null = null)`.

- [ ] **Step 1: Write the failing tests**

`claude-md.test.mjs` (append; follow the file's existing `buildClaudeMd` call shape):

```js
test("an issue replaces the inline link with the issue section", () => {
  const issue = { ref: "o/r#5", url: "https://github.com/o/r/issues/5", title: "Stale config", fetchedAt: "2026-10-11T18:04:00.000Z" };
  const md = buildClaudeMd("ws", "/ws", [], "Fix it", { ISSUE_ID: "o/r#5" }, null, issue);
  assert.match(md, /## Current Task\n\nFix it\n\n/);
  assert.match(md, /## Issue\n\n\[o\/r#5\]\(https:\/\/github.com\/o\/r\/issues\/5\): Stale config\./);
});
```

`workspace-init-seed.test.mjs` (append):

```js
test("an issue seeds the handoff even with an empty prompt, issue section first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  seedStartingHandoff(root, "", "bugfix", { ref: "o/r#5", url: null, title: "T", fetchedAt: "2026-10-11T00:00:00.000Z" });
  const [note] = fs.readdirSync(path.join(root, ".sandbox", "notes"));
  const body = fs.readFileSync(path.join(root, ".sandbox", "notes", note), "utf8");
  assert.match(body, /# Handoff: workspace creation\n\n## Issue\n\no\/r#5: T\./);
});
```

`workspace-init-issue.test.mjs` (new):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withFakeGh, withSandboxHome } from "./fixtures.mjs";
import { resolveIssueCopy } from "./dist/workspace_init.js";
import { ISSUE_COPY } from "./dist/issue_snapshot.js";
import { seedWorkspaceMetadataEnv } from "./dist/generate.js";

const GH = "overrides:\n  issue_tracker: github\n";
const ISSUE = { title: "T", state: "OPEN", body: "b", url: "https://github.com/o/r/issues/5", labels: [], assignees: [], comments: [] };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));

test("missing copy renders the no-copy section", async () => {
  await withSandboxHome(async () => {
    const ref = await resolveIssueCopy(tmp(), "o/r#5", {});
    assert.equal(ref.fetchedAt, null);
  }, { config: GH });
});

test("refresh writes the copy; a failed refresh keeps the old one", async () => {
  await withSandboxHome(async () => {
    const root = tmp();
    await withFakeGh({ issue: ISSUE }, () => resolveIssueCopy(root, "o/r#5", { refresh: true }));
    const before = fs.readFileSync(path.join(root, ISSUE_COPY), "utf8");
    await withFakeGh({ issue: null }, async () => {
      await assert.rejects(resolveIssueCopy(root, "o/r#5", { refresh: true }), /couldn't read o\/r#5/);
    });
    assert.equal(fs.readFileSync(path.join(root, ISSUE_COPY), "utf8"), before);
  }, { config: GH });
});

test("refresh without issue_id fails cleanly", async () => {
  const root = tmp();
  await assert.rejects(resolveIssueCopy(root, "", { refresh: true }), /no issue_id/);
  assert.equal(fs.existsSync(path.join(root, ISSUE_COPY)), false);
});

test("multi-line DESCRIPTION is one .env line", () => {
  const env = path.join(tmp(), ".env");
  seedWorkspaceMetadataEnv(env, { FEATURE: "f", DESCRIPTION: "line one\n\n  line two" });
  assert.equal(fs.readFileSync(env, "utf8"), "FEATURE=f\nDESCRIPTION=line one line two\n");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sandbox-core && npm run build && node --test claude-md.test.mjs workspace-init-seed.test.mjs workspace-init-issue.test.mjs`
Expected: FAIL — `resolveIssueCopy` not exported; no `## Issue` in output; `.env` keeps the newline.

- [ ] **Step 3: Implement**

`generate.ts`:

```ts
export function seedWorkspaceMetadataEnv(envPath: string, meta: Record<string, string>): void {
  // One line per key: a multi-line value (a distilled description) would end the entry early.
  const body = Object.entries(meta)
    .map(([k, v]) => `${k}=${String(v).replace(/\s*\n\s*/g, " ").trim()}\n`)
    .join("");
  fs.writeFileSync(envPath, preservedEnvMetadata(envPath, new Set(Object.keys(meta))) + body);
}
```

`claude_md.ts` — add the parameter `issue: IssueRef | null = null` last on `buildClaudeMd`, import `renderIssueRef` and `IssueRef`, and change the Current Task block:

```ts
  const link = issue ? null : issueLink(meta);
  const currentTaskLine = !link ? task : link[1] ? `${task} — [${link[0]}](${link[1]})` : `${task} — ${link[0]}`;
  // ...taskBody unchanged...
  const currentTaskSection = `## Current Task\n\n${currentTaskLine}\n\n${issue ? `${renderIssueRef(issue)}\n` : ""}${taskBody}\n`;
```

`strategies/jit.ts` — `seedStartingHandoff(workspaceRoot, startingPrompt, workType, issue: IssueRef | null = null)`: change the early return to `if (!prompt && !issue) return;`, push the issue section right after `"# Handoff: workspace creation", ""`:

```ts
    if (issue) lines.push(renderIssueRef(issue));
```

and push `prompt` only when non-empty. Update the call: `seedStartingHandoff(workspaceRoot, inputs["starting_prompt"] ?? "", inputs["work_type"] ?? "", ctx.issue ?? null);` and pass `ctx.issue ?? null` as `buildClaudeMd`'s last argument (read `ctx` from jit's `init(ctx)` signature).

`workspace_init.ts`:

```ts
import { IssueFetchError, fetchIssueSnapshot, readIssueRef, writeIssueCopy, type IssueSnapshot } from "./issue_snapshot.js";
import type { IssueRef } from "./strategies/types.js";

// in InitWorkspaceOptions:
  /** The snapshot createWorkspace fetched; written to .sandbox/issue.md before the strategy runs. */
  issue?: IssueSnapshot;

/**
 * Write the issue copy when one is handed over or a refresh is asked for, then
 * return what the strategy renders. A failed refresh throws before writing, so
 * the old copy survives.
 */
export async function resolveIssueCopy(
  root: string,
  issueId: string,
  opts: { issue?: IssueSnapshot; refresh?: boolean },
): Promise<IssueRef | null> {
  if (opts.issue) {
    writeIssueCopy(root, opts.issue);
  } else if (opts.refresh) {
    if (!issueId) throw new WorkspaceInitError("--refresh-issue: this workspace has no issue_id.");
    try {
      writeIssueCopy(root, await fetchIssueSnapshot(issueId));
    } catch (e) {
      if (e instanceof IssueFetchError) throw new WorkspaceInitError(`${e.message}; run \`sandbox connect\` to check the issue tracker.`);
      throw e;
    }
  }
  return readIssueRef(root, issueId);
}
```

In `initWorkspace`, after `writeWorkspaceConfig(workspaceRoot, inputs);`:

```ts
  // 2b. The issue copy (.sandbox/issue.md): handed over at creation, refreshed on request, else read back.
  const issueId = inputs["issue_id"] ? (issueTracker().parseRef(inputs["issue_id"]) ?? inputs["issue_id"]) : "";
  let issue: IssueRef | null;
  try {
    issue = await resolveIssueCopy(workspaceRoot, issueId, { issue: opts.issue, refresh: Boolean(args["refresh_issue"]) });
  } catch (e) {
    if (e instanceof WorkspaceInitError) fail(e.message);
    throw e;
  }
```

(If `issueTracker` is not yet imported in `workspace_init.ts`, it is — `provisionWorkspace` uses it.) Pass `issue` in the `strategy.init({...})` object.

CLI: in `apps/cli/src/main.ts` `init-workspace` `configure`, add `.option("--refresh-issue", "Re-fetch the workspace's issue into .sandbox/issue.md (BRIEF.md is not rewritten).")` and `refresh_issue: Boolean(o.refreshIssue),` in its namespace. `init_workspace.ts` already forwards `args` to `initWorkspace`; confirm `refresh_issue` reaches it (add it to any explicit arg list there).

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/sandbox-core && npm test` then `cd apps/cli && npm test`
Expected: all pass (the existing JIT snapshot test `strategy-jit-snapshot.test.mjs` must still pass unchanged: no issue → identical output).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core apps/cli/src/main.ts apps/cli/src/commands/init_workspace.ts
git commit -m "feat(core): init-workspace writes/refreshes .sandbox/issue.md; JIT issue section

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `createWorkspace` pipeline (`prepareCreate`, `distillIssue`)

**Files:**
- Modify: `packages/sandbox-core/sandbox.ts` (`buildIssueFormRequest` ~431, `createWorkspace` ~822)
- Test: new `packages/sandbox-core/create-pipeline.test.mjs`

**Interfaces:**
- Consumes: `fetchIssueSnapshot`, `IssueFetchError`, `IssueSnapshot` (Task 1); `InitWorkspaceOptions.issue` (Task 3); `checkAuth` is optional here (Task 6 adds the fix line).
- Produces:
  - `type Distiller = (prompt: string) => Promise<string | null>`
  - `interface CreateOptions { open?: boolean; onData?: (chunk: string) => void; live?: boolean; cwd?: string; distill?: false | Distiller; issue?: IssueSnapshot; readStdinTask?: () => string; force?: boolean }`
  - `prepareCreate(formData: Record<string, unknown>, opts?: CreateOptions): Promise<{ resolved: Record<string, string>; issue: IssueSnapshot | null }>`
  - `distillIssue(issue: IssueSnapshot, distill: Distiller = askClaude): Promise<{ fields: Record<string, string>; warning: string | null }>`
  - `createWorkspace(formData, opts?: CreateOptions): Promise<CreateResult>`

- [ ] **Step 1: Write the failing tests** `create-pipeline.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withFakeGh, withSandboxHome } from "./fixtures.mjs";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { createWorkspace, prepareCreate } from "./dist/sandbox.js";

const GH = "overrides:\n  issue_tracker: github\n";
const ISSUE = { title: "Stale config", state: "OPEN", body: "Body.", url: "https://github.com/o/r/issues/5", labels: [], assignees: [], comments: [] };
const ANSWER = '<result>{"description":"Distilled.","starting_prompt":"## Goal\\n\\nFix."}</result>';
const cwd = () => fs.mkdtempSync(path.join(os.tmpdir(), "cwd-"));
const quiet = (fn) => withReporter(collectingReporter(), fn);

test("an issue fills task from the title and distils only empty fields", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const { resolved, issue } = await quiet(() =>
        prepareCreate({ feature: "f", issue_id: "o/r#5", description: "Mine." }, { cwd: cwd(), distill: async () => ANSWER }));
      assert.equal(issue.title, "Stale config");
      assert.equal(resolved.task, "Stale config");
      assert.equal(resolved.description, "Mine.");
      assert.equal(resolved.starting_prompt, "## Goal\n\nFix.");
    });
  }, { config: GH });
});

test("URL ref is normalised", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const { resolved } = await quiet(() =>
        prepareCreate({ feature: "f", issue_id: "https://github.com/o/r/issues/5" }, { cwd: cwd(), distill: false }));
      assert.equal(resolved.issue_id, "o/r#5");
    });
  }, { config: GH });
});

test("a failed distill still prepares, with a warning", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const rep = collectingReporter();
      const { resolved, issue } = await withReporter(rep, () =>
        prepareCreate({ feature: "f", issue_id: "o/r#5" }, { cwd: cwd(), distill: async () => null }));
      assert.ok(issue);
      assert.equal(resolved.starting_prompt, undefined);
      assert.match(rep.text(), /not filled from the issue/);
    });
  }, { config: GH });
});

test("distill: false never calls a model", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const { resolved } = await quiet(() => prepareCreate({ feature: "f", issue_id: "o/r#5" }, { cwd: cwd(), distill: false }));
      assert.equal(resolved.description, undefined);
    });
  }, { config: GH });
});

test("a fetch failure creates nothing", async () => {
  await withSandboxHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsroot-"));
    const prev = process.env.SANDBOX_WORKSPACES_ROOT;
    process.env.SANDBOX_WORKSPACES_ROOT = root;
    try {
      await withFakeGh({ issue: null }, async () => {
        await assert.rejects(createWorkspace({ feature: "f", issue_id: "o/r#5" }, { open: false, cwd: cwd(), distill: false }), /couldn't read o\/r#5/);
      });
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      if (prev === undefined) delete process.env.SANDBOX_WORKSPACES_ROOT;
      else process.env.SANDBOX_WORKSPACES_ROOT = prev;
    }
  }, { config: GH });
});

test("an unparseable ref fails with the tracker's example", async () => {
  await withSandboxHome(async () => {
    await assert.rejects(quiet(() => prepareCreate({ feature: "f", issue_id: "nonsense" }, { cwd: cwd(), distill: false })),
      /isn't a GitHub issue ref \(e\.g\. owner\/repo#12\)/);
  }, { config: GH });
});
```

Verify `SANDBOX_WORKSPACES_ROOT` is the env `resolveWorkspacesRoot()` reads (`grep -n SANDBOX_WORKSPACES_ROOT packages/sandbox-core/*.ts`); use whatever name it reads.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sandbox-core && npm run build && node --test create-pipeline.test.mjs`
Expected: FAIL — `prepareCreate` is not exported.

- [ ] **Step 3: Implement in `sandbox.ts`**

Extract the prompt half of `buildIssueFormRequest` so both paths share it:

```ts
/** The distillation prompt for one fetched issue's briefing. */
async function issueExtractPrompt(ref: string, briefing: string): Promise<string> {
  const registry = await readServicesRegistry();
  const serviceNames = registry ? parseServiceNames(registry) : [];
  return buildIssueExtractPrompt(issueTracker().label, ref, registry, serviceNames, briefing);
}
```

and make `buildIssueFormRequest` end with `return { base, prompt: await issueExtractPrompt(ref, briefing) };`.

Add:

```ts
export type Distiller = (prompt: string) => Promise<string | null>;

export interface CreateOptions {
  open?: boolean;
  onData?: (chunk: string) => void;
  /** Report through the caller's reporter (the CLI's terminal) instead of collecting a transcript. */
  live?: boolean;
  /** Where inputs resolve from; $HOME by default so a stray ./.sandbox/workspace.yml can't leak in. */
  cwd?: string;
  /** The model behind the issue rewrite (default `askClaude`); false skips it. */
  distill?: false | Distiller;
  /** A snapshot the caller already fetched (the CLI wizard), so it isn't fetched twice. */
  issue?: IssueSnapshot;
  readStdinTask?: () => string;
  force?: boolean;
}

const DISTILLED = ["feature", "task", "description", "starting_prompt", "services"] as const;

/** The model's rewrite of one issue into form fields; never throws. */
export async function distillIssue(
  issue: IssueSnapshot,
  distill: Distiller = askClaude,
): Promise<{ fields: Record<string, string>; warning: string | null }> {
  const briefing = issueBriefing({ ref: issue.ref, title: issue.title, status: issue.status, description: issue.body, url: issue.url ?? undefined, comments: issue.comments });
  let answer: string | null = null;
  try {
    answer = await distill(await issueExtractPrompt(issue.ref, briefing));
  } catch (e) {
    return { fields: {}, warning: (e as Error).message };
  }
  if (answer === null) return { fields: {}, warning: "the model gave no answer" };
  const data = await applyIssueFormAnswer({}, answer);
  const fields: Record<string, string> = {};
  for (const k of DISTILLED) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) fields[k] = v.trim();
    else if (Array.isArray(v) && v.length) fields[k] = v.map(String).join(",");
  }
  return Object.keys(fields).length ? { fields, warning: null } : { fields, warning: "the answer held no usable fields" };
}

/** Resolve inputs, fetch the issue (failing the create), then fill empty fields from it. */
export async function prepareCreate(
  formData: Record<string, unknown>,
  opts: CreateOptions = {},
): Promise<{ resolved: Record<string, string>; issue: IssueSnapshot | null }> {
  const resolved = resolveInputs(formData, opts.cwd ?? os.homedir());
  if (!resolved.issue_id) return { resolved, issue: null };

  const tracker = issueTracker();
  const ref = tracker.parseRef(resolved.issue_id);
  if (!ref) throw new WorkspaceError(`${resolved.issue_id} isn't a ${tracker.label} issue ref (e.g. ${tracker.refExample})`);
  resolved.issue_id = ref;

  let issue = opts.issue ?? null;
  if (!issue) {
    try {
      issue = await fetchIssueSnapshot(ref);
    } catch (e) {
      if (e instanceof IssueFetchError) throw new WorkspaceError(`${e.message}; run \`sandbox connect\` to check the issue tracker.`);
      throw e;
    }
  }
  if (!resolved.task && issue.title) resolved.task = issue.title;

  if (opts.distill !== false && (!resolved.description || !resolved.starting_prompt)) {
    const { fields, warning } = await distillIssue(issue, opts.distill ?? askClaude);
    for (const [k, v] of Object.entries(fields)) if (!resolved[k]) resolved[k] = v;
    if (warning) warn(`description/starting_prompt not filled from the issue: ${warning}`);
  }
  return { resolved, issue };
}
```

Replace `createWorkspace`'s signature and body (keep its docstring, updated to describe the issue step):

```ts
export async function createWorkspace(formData: Record<string, unknown>, opts: CreateOptions = {}): Promise<CreateResult> {
  const args = buildWorkspaceArgs(formData);
  const command = `sandbox ${args.join(" ")}`;
  const run = async () => {
    const { resolved, issue } = await prepareCreate(formData, opts);
    return provisionWorkspace(resolved, { issue: issue ?? undefined, readStdinTask: opts.readStdinTask, force: opts.force });
  };

  const reporter = collectingReporter(opts.onData);
  let workspacePath: string | null;
  try {
    workspacePath = opts.live ? await run() : await withReporter(reporter, run);
  } catch (e) {
    if (opts.live) throw new WorkspaceError((e as Error).message);
    const detail = stripAnsi(reporter.text().trim()) || (e as Error).message;
    throw new WorkspaceError(`${command} failed:\n${detail}`);
  }
  // ...the rest (output, open in VS Code, return) unchanged...
}
```

Imports to add in `sandbox.ts`: `fetchIssueSnapshot, IssueFetchError, type IssueSnapshot` from `./issue_snapshot.js`; `warn` from `./reporter.js` if not already imported. Note `prepareCreate` errors are thrown inside the collecting reporter, so the non-live message is `"<command> failed:\n<message>"` — the test matches the substring.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/sandbox-core && npm test`
Expected: all pass; `reporter.test.mjs` unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/sandbox.ts packages/sandbox-core/create-pipeline.test.mjs
git commit -m "feat(core): createWorkspace fetches the issue (failing the create) and distils empty fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: CLI through `createWorkspace`, wizard issue step, browser-form prefill, guard

**Files:**
- Modify: `apps/cli/src/commands/workspace.ts`
- Modify: `apps/cli/src/lib/wizard.ts` (`runFormWizard` ~365)
- Modify: `apps/cli/src/main.ts` (`workspace` options/namespace ~478-551)
- Modify: `apps/sandbox-dashboard/form-cli.ts` (`--prefill`)
- Create: `packages/sandbox-core/create-entry-guard.test.mjs`
- Test: new `apps/cli/src/commands/__tests__/workspace_create.test.ts`, `apps/cli/src/lib/__tests__/wizard_after_field.test.ts`

**Interfaces:**
- Consumes: `createWorkspace`, `CreateOptions`, `distillIssue`, `fetchIssueSnapshot`, `WorkspaceError` (core).
- Produces: `runFormWizard(bundle, resolved, { intro?, afterField?: (key: string, resolved: Record<string, string>) => Promise<Record<string, string>> })`; exported `browserFormCommand(node: string, cliJs: string, args: Record<string, unknown>): string[]` in `workspace.ts`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/commands/__tests__/workspace_create.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
vi.mock("sandbox-core", () => ({
  createWorkspace: async (...a: unknown[]) => { calls.push(a); return { workspacePath: "/ws/x" }; },
  WorkspaceError: class extends Error {},
}));
vi.mock("sandbox-core/workspace_prompts", () => ({ resolveInputs: (a: Record<string, unknown>) => ({ feature: a.feature, issue_id: a.issue_id }), workspacePromptSpec: () => ({}) }));

const { run, browserFormCommand } = await import("../workspace.js");

describe("sandbox workspace", () => {
  it("creates through createWorkspace, live, from the cwd, with --no-distill honoured", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await run({ feature: "f", issue_id: "o/r#5", no_distill: true });
    const [formData, opts] = calls[0] as [Record<string, string>, Record<string, unknown>];
    expect(formData).toMatchObject({ feature: "f", issue_id: "o/r#5" });
    expect(opts).toMatchObject({ live: true, open: false, cwd: process.cwd(), distill: false });
  });

  it("--browser-form forwards every given flag as --prefill JSON", () => {
    const cmd = browserFormCommand("node", "form-cli.js", { feature: "f", services: "cli", issue_id: "o/r#5", open_vscode: true, browser_form: true });
    expect(cmd.slice(0, 2)).toEqual(["node", "form-cli.js"]);
    expect(cmd).toContain("--open");
    expect(JSON.parse(cmd[cmd.indexOf("--prefill") + 1])).toEqual({ feature: "f", services: "cli", issue_id: "o/r#5" });
  });
});
```

`apps/cli/src/lib/__tests__/wizard_after_field.test.ts` — follow `wizard_refine.test.ts`'s mocking of the prompt layer; the assertion:

```ts
it("afterField answers become later fields' defaults", async () => {
  // bundle with fields issue_id, task; promptOne mocked to return its default for task and "o/r#5" for issue_id
  const out = await runFormWizard(bundle, {}, { afterField: async (k) => (k === "issue_id" ? { task: "From issue" } : {}) });
  expect(out).toEqual({ issue_id: "o/r#5", task: "From issue" });
});
```

(Build `bundle` with the same helper `wizard_choices.test.ts` uses for a two-field schema; mock `promptOne` as that file does.)

`packages/sandbox-core/create-entry-guard.test.mjs`:

```js
// One create entry point: apps and plugins call createWorkspace, never provisionWorkspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const SKIP = new Set(["node_modules", "dist", "__tests__", ".turbo"]);

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

test("no app or plugin calls provisionWorkspace", () => {
  const hits = ["apps", "plugins"].flatMap((d) => sources(path.join(REPO, d)))
    .filter((f) => /\bprovisionWorkspace\b/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(REPO, f));
  assert.deepEqual(hits, []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cli && npm test -- workspace_create wizard_after_field` and `cd packages/sandbox-core && node --test create-entry-guard.test.mjs`
Expected: FAIL — `browserFormCommand` not exported; createWorkspace not called; guard lists `apps/cli/src/commands/workspace.ts`.

- [ ] **Step 3: Implement**

`wizard.ts`:

```ts
export async function runFormWizard(
  bundle: Record<string, any>,
  resolved: Record<string, string>,
  {
    intro = null,
    afterField,
  }: { intro?: string | null; afterField?: (key: string, resolved: Record<string, string>) => Promise<Record<string, string>> } = {},
): Promise<Record<string, string>> {
  if (intro) info(intro);
  const defaults: Record<string, string> = {};
  for (const field of fieldsOf(bundle)) {
    if (!(field.key in resolved)) {
      await askField(defaults[field.key] ? { ...field, default: defaults[field.key] } : field, resolved);
    }
    if (afterField && field.key in resolved) Object.assign(defaults, await afterField(field.key, resolved));
  }
  return resolved;
}
```

`workspace.ts` — replace `resolveWorkspaceInputs`, `runBrowserForm`'s argv building and `run`:

```ts
import { WorkspaceError, createWorkspace, distillIssue } from "sandbox-core";
import { fetchIssueSnapshot, type IssueSnapshot } from "sandbox-core/issue_snapshot";

/** CLI keys the form knows; everything else (browser_form, open_vscode, force, no_distill) is a CLI switch. */
const FORM_KEYS = ["feature", "issue_id", "services", "repos", "labels", "task", "test_path", "description", "starting_prompt", "work_type", "context_strategy"];

export function browserFormCommand(node: string, cliJs: string, args: Record<string, unknown>): string[] {
  const prefill = Object.fromEntries(FORM_KEYS.filter((k) => args[k] != null && args[k] !== "").map((k) => [k, args[k]]));
  const cmd = [node, cliJs];
  if (Object.keys(prefill).length) cmd.push("--prefill", JSON.stringify(prefill));
  if (args.open_vscode) cmd.push("--open");
  return cmd;
}

async function resolveWorkspaceInputs(args: Record<string, unknown>): Promise<{ resolved: Record<string, string>; issue?: IssueSnapshot }> {
  const base = process.cwd();
  let resolved = resolveInputs(args, base);
  let issue: IssueSnapshot | undefined;
  if (process.stdin.isTTY) {
    resolved = await runFormWizard(buildFormSchema(workspacePromptSpec(base, resolved)), resolved, {
      intro: "Interactive wizard — press Ctrl-C to abort. Defaults shown in [brackets].",
      // Typed in the wizard: read the issue now so later prompts default to it.
      afterField: async (key, r) => {
        // A flag-supplied issue is createWorkspace's to handle; this is for one typed into the wizard.
        if (key !== "issue_id" || !r.issue_id || args.issue_id) return {};
        issue = await fetchIssueSnapshot(r.issue_id);
        if (args.no_distill) return { task: issue.title };
        const { fields, warning } = await distillIssue(issue);
        if (warning) info(`Issue read; fields not pre-filled: ${warning}`);
        return { task: issue.title, ...fields };
      },
    });
  }
  return { resolved, issue };
}
```

```ts
export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.browser_form) {
    runBrowserForm(args);
    return;
  }
  const { resolved, issue } = await resolveWorkspaceInputs(args);
  try {
    await createWorkspace(resolved, {
      live: true,
      open: Boolean(args.open_vscode),
      cwd: process.cwd(),
      issue,
      // The wizard already distilled (and the person reviewed) when it read the issue.
      distill: args.no_distill || issue ? false : undefined,
      readStdinTask,
      force: Boolean(args.force),
    });
  } catch (exc) {
    if (exc instanceof WorkspaceError || exc instanceof WorkspaceInitError) {
      error((exc as Error).message);
      process.exit(1);
    }
    throw exc;
  }
}
```

In `runBrowserForm`, replace the argv lines with `const cmd = browserFormCommand(node, cliJs, args);`. Remove the `provisionWorkspace` import. Add `"./issue_snapshot": "./dist/issue_snapshot.js"` to `packages/sandbox-core/package.json` `exports` (it is not there today).

`main.ts` `workspace` command: add `.option("--no-distill", "Store the issue but don't have a model rewrite it into description/starting_prompt.")` and `no_distill: o.distill === false,` in the namespace (commander turns `--no-distill` into `distill: false`). Update the `--browser-form` help to say every given flag pre-fills the form.

`form-cli.ts`: parse `--prefill <json>` into `out.prefill` (`JSON.parse`, ignore on error with a stderr note); when building the form's initial `formData`, spread `{ ...issueData, ...args.prefill }` so explicit CLI values win over the issue's.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/sandbox-core && npm run build && npm test && cd ../../apps/cli && npm test && cd ../sandbox-dashboard && npm test`
Expected: all pass; guard passes.

- [ ] **Step 5: Commit**

```bash
git add apps/cli apps/sandbox-dashboard/form-cli.ts packages/sandbox-core/create-entry-guard.test.mjs packages/sandbox-core/package.json
git commit -m "feat(cli): sandbox workspace goes through createWorkspace; wizard reads the issue; --browser-form forwards flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tracker `checkAuth`, Jira placeholders (#114), `sandbox connect`

**Files:**
- Modify: `packages/sandbox-core/issue_trackers/types.ts`, `github.ts`, `jira.ts`
- Modify: `packages/sandbox-core/jira-rest.ts` (export `isJiraPlaceholder`, `jiraMyself`), `machine_setup.ts:766` (import the set instead of defining it)
- Modify: `packages/sandbox-core/sandbox.ts` (`prepareCreate` adds the fix line)
- Modify: `apps/cli/src/commands/connect.ts`
- Test: `packages/sandbox-core/issue-tracker.test.mjs`, new `apps/cli/src/commands/__tests__/connect_tracker.test.ts`

**Interfaces:**
- Produces: `IssueTrackerStrategy.checkAuth(): Promise<TrackerAuth>` with `interface TrackerAuth { ok: boolean; who?: string; reason?: string; fix: string }`; `isJiraPlaceholder(v: string): boolean`; `jiraMyself(): Promise<{ who: string } | null>` (throws on HTTP failure, null when no creds); `trackerLine(label: string, auth: TrackerAuth): string` exported from `connect.ts`.

- [ ] **Step 1: Write the failing tests** — append to `issue-tracker.test.mjs`:

```js
import { withFakeGh } from "./fixtures.mjs";

test("github checkAuth: signed in, signed out, no repo access", async () => {
  await withSandboxHome(async () => {
    const t = it.issueTracker();
    await withFakeGh({ auth: 0 }, async () => assert.deepEqual(await t.checkAuth(), { ok: true, who: "octo", fix: "" }));
    await withFakeGh({ auth: 1 }, async () => assert.deepEqual(await t.checkAuth(), { ok: false, reason: "not signed in", fix: "gh auth login" }));
  }, { config: "overrides:\n  issue_tracker: github\n" });
});

test("jira placeholder base_url counts as not configured (#114)", async () => {
  await withSandboxHome(async () => {
    const t = it.issueTracker();
    assert.equal(t.url("PROJ-1"), null);
    const a = await t.checkAuth();
    assert.equal(a.ok, false);
    assert.match(a.fix, /jira-rest-setup\.md/);
  }, { config: "jira:\n  base_url: https://your-org.atlassian.net\n  email: a@b.c\n  api_token: x\n" });
});
```

(The "no repo access" case needs `githubIssueRepos()` to return a repo; set it the way `githubIssueRepos` reads config — check `issue_trackers/github.ts:34` — and add `withFakeGh({ auth: 0, repoView: 1 })` expecting `{ ok: false, who: "octo", reason: "can't read <repo>", fix: "gh auth refresh -s repo" }`.)

`connect_tracker.test.ts`:

```ts
import { expect, it } from "vitest";
const { trackerLine } = await import("../connect.js");

it("formats the tracker line", () => {
  expect(trackerLine("GitHub", { ok: true, who: "octo", fix: "" })).toContain("issue tracker · GitHub · ok (octo)");
  expect(trackerLine("GitHub", { ok: false, reason: "not signed in", fix: "gh auth login" })).toMatch(/issue tracker · GitHub · not signed in — run: gh auth login/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sandbox-core && npm run build && node --test issue-tracker.test.mjs`; `cd apps/cli && npm test -- connect_tracker`
Expected: FAIL — `checkAuth` is not a function; `trackerLine` undefined.

- [ ] **Step 3: Implement**

`types.ts` — add `TrackerAuth` and, on the interface:

```ts
  /** Whether this machine can read issues, and the one command or doc that fixes it. Never throws. */
  checkAuth(): Promise<TrackerAuth>;
```

`github.ts`:

```ts
  async checkAuth() {
    const run = (args: string[]) => runAsync([ghBin(), ...args], { capture: true, env: childEnv(), timeout: 15 }).catch(() => null);
    const s = await run(["auth", "status", "--hostname", "github.com"]);
    if (!s || s.status !== 0) return { ok: false, reason: "not signed in", fix: "gh auth login" };
    const who = /account (\S+)/.exec(`${s.stdout}${s.stderr}`)?.[1];
    for (const repo of githubIssueRepos()) {
      const v = await run(["repo", "view", repo, "--json", "name"]);
      if (!v || v.status !== 0) return { ok: false, ...(who ? { who } : {}), reason: `can't read ${repo}`, fix: "gh auth refresh -s repo" };
    }
    return { ok: true, ...(who ? { who } : {}), fix: "" };
  },
```

`jira-rest.ts` — move the set from `machine_setup.ts` verbatim and export:

```ts
export const JIRA_PLACEHOLDERS = new Set(["PASTE_TOKEN_HERE", "<your-atlassian-login-email>", "https://your-org.atlassian.net"]);
export const isJiraPlaceholder = (v: string): boolean => JIRA_PLACEHOLDERS.has(v.trim().replace(/\/+$/, ""));
```

In `normalizeCreds`, return null when `isJiraPlaceholder(trimmed) || isJiraPlaceholder(email) || isJiraPlaceholder(token)` (replacing the `UNFILLED_TOKEN` check). Add:

```ts
/** Who the configured token signs in as; null without usable creds. Throws on HTTP failure. */
export async function jiraMyself(): Promise<{ who: string } | null> {
  const creds = await jiraCreds();
  if (!creds) return null;
  const r = await jiraFetch(creds, "/rest/api/3/myself");
  const j = (await r.json()) as { emailAddress?: string; displayName?: string };
  return { who: j.emailAddress ?? j.displayName ?? creds.email };
}
```

`machine_setup.ts` — delete its `JIRA_PLACEHOLDERS` and `import { JIRA_PLACEHOLDERS } from "./jira-rest.js";`.

`jira.ts` — in `jiraBrowseUrl` and `jiraSiteRef`, treat `isJiraPlaceholder(base)` like an empty base (return null). Add:

```ts
  async checkAuth() {
    const fix = "set jira.base_url, jira.email and jira.api_token (docs/jira-rest-setup.md)";
    try {
      const me = await jiraMyself();
      return me ? { ok: true, who: me.who, fix: "" } : { ok: false, reason: "no Jira API token configured", fix };
    } catch (e) {
      return { ok: false, reason: (e as Error).message, fix };
    }
  },
```

`sandbox.ts` `prepareCreate`: in the `IssueFetchError` branch, append the auth fix when sign-in is the cause:

```ts
      if (e instanceof IssueFetchError) {
        const auth = await tracker.checkAuth();
        const hint = auth.ok ? "run `sandbox connect` to check the issue tracker" : `${tracker.label}: ${auth.reason}; run: ${auth.fix}`;
        throw new WorkspaceError(`${e.message}; ${hint}.`);
      }
```

(Task 4's test `/couldn't read o\/r#5/` still matches; the fake `gh` signs in, so the hint is the connect one.)

`connect.ts`:

```ts
import * as readline from "node:readline/promises";
import { issueTracker, type TrackerAuth } from "sandbox-core/issue_tracker";
import { ghBin } from "sandbox-core/issue_tracker";
import { run as procRun } from "sandbox-core/proc";

export function trackerLine(label: string, auth: TrackerAuth): string {
  return auth.ok
    ? `  ${Colors.GREEN}issue tracker · ${label} · ok${auth.who ? ` (${auth.who})` : ""}${Colors.RESET}`
    : `  ${Colors.YELLOW}issue tracker · ${label} · ${auth.reason} — run: ${auth.fix}${Colors.RESET}`;
}

/** Report tracker sign-in; on a TTY, offer GitHub's own login. Never fails connect. */
async function checkTracker(): Promise<void> {
  const tracker = issueTracker();
  let auth = await tracker.checkAuth();
  if (!auth.ok && tracker.id === "github" && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const yes = /^y/i.test(await rl.question(`  GitHub: ${auth.reason}. Sign in now? (${auth.fix}) [y/N] `));
    rl.close();
    if (yes) {
      procRun([ghBin(), ...auth.fix.split(" ").slice(1)], { stdio: "inherit" });
      auth = await tracker.checkAuth();
    }
  }
  console.log(trackerLine(tracker.label, auth));
}
```

Call `await checkTracker();` in `run` right after the healthy/down summary block and before "Developer tools". In `issue_tracker.ts`, add `TrackerAuth` to the `export type { … } from "./issue_trackers/types.js"` line and `ghBin` to the `export { … } from "./issue_trackers/github.js"` line (no new package export needed).

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/sandbox-core && npm run build && npm test && cd ../../apps/cli && npm test`
Expected: all pass, including the existing `machine_setup` / setup-report tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core apps/cli/src/commands/connect.ts apps/cli/src/commands/__tests__/connect_tracker.test.ts
git commit -m "feat: tracker checkAuth; sandbox connect reports and offers gh sign-in; placeholder Jira base_url is unset (#114)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Pane — session-model distill on Create, tracker on the infra line

**Files:**
- Modify: `plugins/sandbox-tools/hooks/register.tsx` (SCRIPT ops ~65-90, `submitForm` ~368, `infraLine` ~491, `tick` ~519, tool description ~670-678)
- Modify: `plugins/sandbox-tools/types/index.d.ts` (state `tracker`)
- Test: `plugins/sandbox-tools/hooks/register.test.ts`

**Interfaces:**
- Consumes: core `createWorkspace(formData, { open: false, distill: false })`, tracker `checkAuth()`.
- Produces: SCRIPT op `tracker-auth` → `TrackerAuth`; state `'sandbox-tools'.tracker: { ok: boolean; reason?: string; fix: string } | null`; `infraLine(i, tracker)`.

- [ ] **Step 1: Write the failing tests** (in `register.test.ts`, using its `world`/`stubs`/`openPane` helpers; stub key `${WS}/tracker-auth`):

```ts
test('Create with an issue and empty fields fills from the issue on the session model, then creates with distill off', async ($, on) => {
  const w = world(on, formStubs())
  const asked = answerIssueModel(on)
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  await ui.press({ key: 'tab:create' })
  await ui.post({ value: 'my-own' }, { in: 'f:feature' })
  await ui.post({ value: 'api#7' }, { in: 'f:issue_id' })
  await ui.select({ key: 'f:work_type', value: 'bugfix' })
  // No "Fill from issue" press: Create does it.
  await ui.press({ key: 'create:go' })
  expect(asked).toEqual([{ model: 'sonnet', prompt: 'EXTRACT acme/api#7' }])
  expect(w.calls.find(c => c.key === `${WS}/create-workspace`)?.args).toEqual({
    formData: { feature: 'my-own', issue_id: 'acme/api#7', task: 'Rate limit the API', services: ['api'], work_type: 'bugfix' },
    distill: false,
  })
  await ui.unmount()
})

test('a signed-out tracker shows on the infra line', async ($, on) => {
  world(on, stubs({ [`${WS}/tracker-auth`]: () => ok({ ok: false, reason: 'not signed in', fix: 'gh auth login' }) }))
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'sandbox-tools', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'workspaces' })
  expect((await ui.find({ key: 'infra' }))?.text).toMatch(/tracker: not signed in · gh auth login/)
  await ui.unmount()
})
```

`formStubs()` and `answerIssueModel()` are the existing helpers the test "fetch fills only the empty fields…" uses; if `services` comes back as something other than `['api']` from `formStubs`' apply stub, use what that stub returns. In that existing test, add `distill: false` to its expected `create-workspace` args. Add `[`${WS}/tracker-auth`]: () => ok({ ok: true, fix: '' })` to the default `stubs()`, and update "workspace data comes from the node child" to include `${WS}/tracker-auth` in its sorted expected list.

- [ ] **Step 2: Run to verify failure**

Run: `cd plugins/sandbox-tools && claude plugin test .`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement**

SCRIPT ops:

```js
    'tracker-auth': () => tracker.checkAuth(),
    // The pane distils on the session's own model (fetchIssue) before Create and sends distill: false.
    'create-workspace': () => core.createWorkspace(args.formData, { open: false, distill: args.distill }),
```

`submitForm`, before `formErrors`:

```ts
  // Core stores the issue but doesn't run a model for the pane: fill empty fields on the session model first.
  if (typeof draft.issue_id === 'string' && draft.issue_id.trim() && (isEmpty(draft.description) || isEmpty(draft.starting_prompt))) {
    await fetchIssue($)
  }
  const { value: filled = {} } = await $.state.get(DRAFT)
```

and use `filled` instead of `draft` for the rest of `submitForm`; its `core(…, 'create-workspace', …)` call sends `{ formData, distill: false }`.

Tracker state, refreshed at most every 5 minutes inside `tick`:

```ts
const TRACKER = { plugin: 'sandbox-tools', key: 'tracker' } as const
export const TRACKER_TTL_MS = 5 * 60 * 1000
let trackerAt = 0
// in tick, after the rows are set:
    if (Date.now() - trackerAt > TRACKER_TTL_MS) {
      trackerAt = Date.now()
      await $.state.set(TRACKER, await core<{ ok: boolean; reason?: string; fix: string }>($, 'tracker-auth').catch(() => null))
    }
```

`infraLine`:

```ts
export function infraLine(i: InfraStatus | null, t: { ok: boolean; reason?: string; fix: string } | null = null): string {
  const tracker = t && !t.ok ? `tracker: ${t.reason} · ${t.fix}` : null
  if (!i) return ['infra · unknown', tracker].filter(Boolean).join(' · ')
  const bad = i.services.filter(s => s.state !== 'healthy' && s.state !== 'running').map(s => `${s.state}: ${s.name}`)
  return ['infra', i.state, i.total > 0 ? `${i.running}/${i.total}` : null, ...bad, tracker].filter(Boolean).join(' · ')
}
```

Read `TRACKER` in the render hook and pass it. Declare `tracker` in `types/index.d.ts` `PluginState['sandbox-tools']`. In the `workspace_form` tool description, change `services and repos (lists of choices)` to `services (a list of choices)`.

- [ ] **Step 4: Run to verify pass**

Run: `cd plugins/sandbox-tools && claude plugin validate . && claude plugin test . && npx tsc -p . --noEmit`
Expected: validate passes, all tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/sandbox-tools
git commit -m "feat(sandbox-tools): Create distils on the session model then creates with distill off; tracker on the infra line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Instructions and docs — one entry point

**Files:**
- Modify: `plugins/sandbox-tools/skills/sandbox-workspace/SKILL.md`
- Modify: `apps/sandbox-dashboard/server.ts` (tool descriptions ~133-139, ~216-218), `apps/mcp/tools.ts` (`sandbox-workspace` description ~411)
- Modify: stale comments `packages/sandbox-core/sandbox.ts:1-14`, `:489`; `apps/sandbox-dashboard/form-cli.ts:13`; `packages/sandbox-core/workspace_prompts.ts:365-367`
- Modify: `docs/context-strategies.md`, `docs/users-guide.md`
- Test: `packages/sandbox-core/create-entry-guard.test.mjs` (add a doc check)

- [ ] **Step 1: Write the failing test** — append to `create-entry-guard.test.mjs`:

```js
test("the sandbox-workspace skill states the one rule and the batch check", () => {
  const skill = fs.readFileSync(path.join(REPO, "plugins/sandbox-tools/skills/sandbox-workspace/SKILL.md"), "utf8");
  assert.match(skill, /Every create goes through `createWorkspace`/);
  assert.match(skill, /\.sandbox\/issue\.md/);
  assert.match(skill, /mcp__plugin_sandbox-tools_sandbox-workspace__workspace/);
  assert.doesNotMatch(skill, /mcp__sandbox-workspace__workspace/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sandbox-core && node --test create-entry-guard.test.mjs`
Expected: FAIL on the first `assert.match`.

- [ ] **Step 3: Rewrite the skill.** Keep the frontmatter `name`/`description`. Replace the body's opening and "Skip the form — direct CLI" section with:

```markdown
# Sandbox Workspace

**Every create goes through `createWorkspace`** (packages/sandbox-core/sandbox.ts) — the CLI,
the browser form, both MCP servers and the /workspaces pane all call it. Never write
workspace files by hand.

With an `issue_id`, `createWorkspace` always:
1. fetches the issue and stores it verbatim in `.sandbox/issue.md` — it **fails the create**
   if the issue can't be read (run `sandbox connect` to check tracker sign-in);
2. fills `task` from the issue title when empty;
3. has a model rewrite the issue into `description` / `starting_prompt` for whichever is
   empty (`--no-distill` skips it; a failed rewrite only warns);
4. renders the issue section (link, copy date, `sandbox issue view`) in CLAUDE.md and the
   brief, for both JIT and ICM.

## Pick the path

| Situation | Do |
|---|---|
| every input known (feature, issue, services) | `sandbox workspace <feature> --issue-id <ref> --services <a,b> [--work-type <t>] [--context-strategy icm]`. Pass `--task` only to override the issue title |
| the person should review the fields first | the /workspaces pane's Create tab, or the browser form (below) |
| many issues at once | one `sandbox workspace` call per issue, **in sequence** (they share source repos), then run the batch check |

**Batch check** — after creating, for each new workspace:

```bash
test -f <ws>/.sandbox/issue.md && grep -q "## Issue" <ws>/CLAUDE.md && echo ok
```

Report any workspace that fails it; don't hand-patch files.
```

Keep the existing "Which browser shows the form", "Preferred path — `--browser-form`", Desktop and prerequisites sections, adding to the `--browser-form` section: "Every flag given alongside `--browser-form` pre-fills the form." Fix the Desktop inline section's tool name to `mcp__plugin_sandbox-tools_sandbox-workspace__workspace`. In "Common pitfalls" add: "**Issue can't be read.** The create fails before anything is made; run `sandbox connect`, fix sign-in, retry."

- [ ] **Step 4: Update MCP descriptions and stale comments**

- `server.ts` `workspace` and `create-workspace` descriptions: replace "spawns/runs `sandbox workspace`" with "creates the workspace through `createWorkspace` in this process; with an `issue_id` the issue is fetched and stored in `.sandbox/issue.md` (the create fails if it can't be read)".
- `apps/mcp/tools.ts` `sandbox-workspace`: same sentence.
- `sandbox.ts:1-14` docstring and `:489` comment, `form-cli.ts:13`: say they call `createWorkspace` → `provisionWorkspace` in-process.
- `workspace_prompts.ts:365-367` `issue_id` help: "Issue ID in this machine's issue tracker. The issue is fetched and stored in the workspace; empty fields are filled from it."

- [ ] **Step 5: Docs**

`docs/context-strategies.md` — after the BRIEF.md row, add the part-2 table from the spec (ICM / JIT × issue section / brief). `docs/users-guide.md` — add a section:

```markdown
## Creating a workspace

Every entry point — `sandbox workspace`, `--browser-form`, the MCP `workspace` /
`create-workspace` tools, and the /workspaces pane — runs the same `createWorkspace`.
With an issue ID it fetches the issue (failing if it can't), stores it in
`.sandbox/issue.md`, fills the task from the title, and rewrites the issue into a
description and starting prompt for any you left empty (`--no-distill` to skip).
Both context strategies show the issue in CLAUDE.md and the brief.

The copy is frozen at creation. To update it: `sandbox init-workspace --refresh-issue`
(the brief is not rewritten). `sandbox connect` reports whether this machine can read
the issue tracker and, on a terminal, offers `gh auth login`.
```

- [ ] **Step 6: Run to verify pass**

Run: `cd packages/sandbox-core && npm run build && npm test && cd ../../apps/mcp && npm test && cd ../sandbox-dashboard && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add plugins/sandbox-tools/skills apps/sandbox-dashboard/server.ts apps/sandbox-dashboard/form-cli.ts apps/mcp/tools.ts packages/sandbox-core docs
git commit -m "docs: one workspace-create entry point in the skill, MCP descriptions and guides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification and backfill

**Files:** none changed in the repo; operates on `~/features/*`.

- [ ] **Step 1: Whole-repo checks**

Run: `npx turbo run build test` from the repo root.
Expected: every package green.

- [ ] **Step 2: Live create smoke** (real tracker, throwaway feature)

```bash
sandbox workspace pipeline-smoke --issue-id jbbz-sandbox/sandbox#118 --repos sandbox --context-strategy icm --no-distill
```

Expected: `~/features/sandbox-118-pipeline-smoke/.sandbox/issue.md` exists with the issue body; `CLAUDE.md` and `BRIEF.md` contain `## Issue`. Then remove it with `sandbox remove-workspace sandbox-118-pipeline-smoke` **only after the person says yes** (removal needs explicit approval).

- [ ] **Step 3: Backfill — ask first, then run** (this regenerates CLAUDE.md in every issue-backed workspace; show the person the list and get a yes):

```bash
for d in ~/features/*/; do
  grep -qE '^(issue_id|jira_id|github_issue):' "$d/.sandbox/workspace.yml" 2>/dev/null || continue
  echo "== $d"; (cd "$d" && sandbox init-workspace --refresh-issue) || echo "FAILED: $d"
done
```

Expected: each prints `Workspace initialised.`; the eight 2026-10-11 workspaces (114–120, 133) get a rebuilt `BRIEF.md` with the issue section; briefs someone edited stay as they were.

- [ ] **Step 4: Batch check**

```bash
for d in ~/features/*/; do
  grep -qE '^issue_id:' "$d/.sandbox/workspace.yml" 2>/dev/null || continue
  test -f "$d/.sandbox/issue.md" && grep -q "## Issue" "$d/CLAUDE.md" && echo "ok   $d" || echo "MISS $d"
done
```

Expected: every line `ok`.
