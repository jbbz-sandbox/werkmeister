# Open Pull Requests Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third "Open Pull Requests" tab to the sandbox MCP workspace browser dashboard that lists my open PRs and others' ready-for-approval PRs, each expandable with an Approve button and a Jira-reconcile-then-triage flow.

**Architecture:** Four new server tools in `lib/sandbox.ts` (pure classification helpers + `gh`/`claude`/Terminal shell-outs), registered in `server.ts`, driven by a new dependency-free `src/prs-ui.ts` tab mounted by `browser-main.ts`. PR bodies render via `markdown-it` (`html:false`). Browser surface only — the MCP-inline and Cowork-artifact surfaces do not get this tab.

**Tech Stack:** TypeScript (ESM/NodeNext), Zod schemas, `@modelcontextprotocol/sdk`, `gh` CLI, local `claude` CLI + Atlassian MCP, `markdown-it`, vanilla DOM, Node `assert` smoke tests.

## Global Constraints

- Package: `apps/mcp-workspace`, `"type": "module"` — all TS imports of local `.ts` files use `.js` extensions (NodeNext).
- Org is `sandbox`; approval label constant is `APPROVAL_LABEL = "ready-for-human-approval"` (defined once in `sandbox.ts`).
- 30-day cutoff computed server-side as `now - 30 days` against each PR's `updatedAt`.
- Both surfaces other than the browser (`mcp-list.ts`, `artifact-main.ts`) must **not** import `prs-ui.ts` or `lib/markdown.ts` (the artifact runs under strict CSP).
- Tool errors use `WorkspaceError`; every server tool returns `{ content: [{type:"text",text}], structuredContent }` on success and `{ isError: true, content: [{type:"text",text}] }` on failure — matching existing tools.
- `markdown-it` configured `html: false` (escapes raw HTML in untrusted PR bodies — the XSS-safety invariant) and `linkify: true`.
- Best-effort everywhere: a single PR's `gh pr view` failure degrades that one card; a Jira lookup failure never blocks the Terminal launch.

**Spec deviation (flag for reviewer):** the spec says `markdown-it` is imported "only by `prs-ui.ts`". The spec's Testing section also requires a Node smoke test proving `html:false`. Node smoke tests import from `dist/lib/*.js`; `src/*.ts` is only vite-bundled, never emitted per-file. So the shared `MarkdownIt` instance lives in `lib/markdown.ts` (compiled → `dist/lib/markdown.js`, importable by the smoke test) and `prs-ui.ts` imports it. The CSP property is preserved: `artifact-main.ts` still never imports it.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/mcp-workspace/package.json` | add `markdown-it` dep + `@types/markdown-it` dev dep |
| `apps/mcp-workspace/lib/markdown.ts` | **new** — shared `MarkdownIt` instance + `renderMarkdown(src)` |
| `apps/mcp-workspace/lib/sandbox.ts` | `APPROVAL_LABEL`, PR types, pure classifiers (`countFailingChecks`, `isWithin30Days`, `prFromView`, `assembleOpenPrs`), `getOpenPrs`, `approvePr`, `fetchJiraIssue`, `openTerminalRunning` (factored out of `resumeClaudeInTerminal`), `openTriageTerminal` |
| `apps/mcp-workspace/server.ts` | register `open-prs`, `pr-approve`, `jira-issue`, `pr-triage` |
| `apps/mcp-workspace/src/prs-ui.ts` | **new** — the tab UI; `initPrsUI(bridge, root)` |
| `apps/mcp-workspace/src/browser-main.ts` | third tab + `#prs` route + lazy mount + document title |
| `apps/mcp-workspace/lib/open-prs.smoke.mjs` | **new** — pure-logic + markdown-config smoke checks |

---

### Task 1: `markdown-it` dependency + shared renderer

**Files:**
- Modify: `apps/mcp-workspace/package.json`
- Create: `apps/mcp-workspace/lib/markdown.ts`

**Interfaces:**
- Produces: `renderMarkdown(src: string): string` — CommonMark+GFM → HTML, raw HTML escaped, bare URLs linkified.

- [ ] **Step 1: Add the dependency**

Run (from repo root, npm workspaces hoist to the root lockfile):
```bash
cd /Users/jayboyer/workspace/sandbox && npm install markdown-it -w apps/mcp-workspace && npm install -D @types/markdown-it -w apps/mcp-workspace
```
Expected: `apps/mcp-workspace/package.json` gains `"markdown-it"` under `dependencies` and `"@types/markdown-it"` under `devDependencies`; root `package-lock.json` updates.

- [ ] **Step 2: Write the renderer**

Create `apps/mcp-workspace/lib/markdown.ts`:
```ts
/**
 * Shared markdown-it renderer for the browser dashboard's PR bodies.
 *
 * `html: false` escapes any raw HTML in the untrusted PR body instead of passing
 * it through — that single flag is the XSS-safety invariant (no separate
 * sanitizer needed). `linkify: true` turns bare URLs into links.
 *
 * Lives in lib/ (not inline in prs-ui.ts) so the compiled dist/lib/markdown.js is
 * importable by lib/open-prs.smoke.mjs, which locks in this config. Only prs-ui.ts
 * (browser bundle) imports it at runtime — the strict-CSP Cowork artifact does not.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true });

/** Render CommonMark/GFM to HTML with raw HTML escaped. Safe to assign via innerHTML. */
export function renderMarkdown(src: string): string {
  return md.render(src ?? "");
}
```

- [ ] **Step 3: Typecheck + build the server bundle**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && npm run build:server
```
Expected: compiles clean; `dist/lib/markdown.js` exists.

- [ ] **Step 4: Verify the config at runtime**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && node -e "import('./dist/lib/markdown.js').then(m=>{const h=m.renderMarkdown('<script>alert(1)</script>\nsee https://x.io'); console.log(h); if(h.includes('<script>')) process.exit(1); if(!h.includes('&lt;script&gt;')) process.exit(2); if(!h.includes('href=\"https://x.io\"')) process.exit(3); console.log('OK');})"
```
Expected: prints escaped `&lt;script&gt;` and an `<a href="https://x.io">` link, then `OK` (exit 0).

- [ ] **Step 5: Commit**
```bash
cd /Users/jayboyer/workspace/sandbox && git add apps/mcp-workspace/package.json apps/mcp-workspace/lib/markdown.ts package-lock.json && git commit -m "feat(mcp-workspace): add markdown-it renderer (html:false) for PR bodies"
```

---

### Task 2: PR data model + pure classification helpers + smoke test

**Files:**
- Modify: `apps/mcp-workspace/lib/sandbox.ts` (add near the existing `getWorkspacePRs` block, ~line 1272)
- Create: `apps/mcp-workspace/lib/open-prs.smoke.mjs`

**Interfaces:**
- Consumes: `parseJiraKey(ref)` (existing, `sandbox.ts:411`), `renderMarkdown` from Task 1.
- Produces:
  - `const APPROVAL_LABEL = "ready-for-human-approval"`
  - `interface OpenPr { url; repo; number; title; author; body; labels: string[]; changesRequested; failingChecks; outOfDate; hasApprovalLabel; jiraKey: string | null }`
  - `interface OpenPrsResult { me: string; mine: OpenPr[]; others: OpenPr[] }`
  - `type ViewResult` (a parsed `gh pr view` object, or an `{ url, unavailable: true }` stub)
  - `countFailingChecks(rollup: unknown): number`
  - `isWithin30Days(updatedAt: string | undefined, nowMs: number): boolean`
  - `prFromView(v: ViewResult, meLogin: string): OpenPr`
  - `assembleOpenPrs(mineViews: ViewResult[], labelViews: ViewResult[], me: string, nowMs: number): OpenPrsResult`

- [ ] **Step 1: Write the failing smoke test**

Create `apps/mcp-workspace/lib/open-prs.smoke.mjs`:
```js
// Smoke test for the Open PRs pure logic: failing-checks classifier, 30-day
// cutoff, prFromView mapping (outOfDate/changesRequested/approval-label/jiraKey/
// repo+number-from-url/unavailable stub), section split with self-exclusion, and
// the markdown-it config invariant (html:false). Synthetic JSON — no network.
//   npm run build && node lib/open-prs.smoke.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { countFailingChecks, isWithin30Days, prFromView, assembleOpenPrs, APPROVAL_LABEL } =
  await import(path.join(pkgRoot, "dist/lib/sandbox.js"));
const { renderMarkdown } = await import(path.join(pkgRoot, "dist/lib/markdown.js"));

// 1. Failing-checks classifier: bad conclusions count; good/in-progress don't.
assert.equal(countFailingChecks([{ conclusion: "FAILURE" }]), 1, "FAILURE counts");
assert.equal(
  countFailingChecks([{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" }]),
  0,
  "SUCCESS/NEUTRAL/SKIPPED do not count",
);
assert.equal(countFailingChecks([{ status: "IN_PROGRESS" }]), 0, "in-progress does not count");
assert.equal(
  countFailingChecks([{ conclusion: "FAILURE" }, { conclusion: "ACTION_REQUIRED" }, { conclusion: "SUCCESS" }]),
  2,
  "counts only the bad ones in a mix",
);
assert.equal(countFailingChecks([{ state: "FAILURE" }]), 1, "StatusContext state=FAILURE counts");
assert.equal(countFailingChecks(null), 0, "non-array rollup → 0");
console.log("✓ countFailingChecks");

// 2. 30-day cutoff.
const now = Date.parse("2026-07-11T00:00:00Z");
assert.equal(isWithin30Days("2026-07-01T00:00:00Z", now), true, "10 days ago is within");
assert.equal(isWithin30Days("2026-05-01T00:00:00Z", now), false, "71 days ago is outside");
assert.equal(isWithin30Days(undefined, now), true, "missing updatedAt → kept");
console.log("✓ isWithin30Days");

// 3. prFromView mapping.
const view = {
  url: "https://github.com/sandbox/econx/pull/1234",
  number: 1234,
  title: "PROJ-999 fix the thing",
  body: "body text",
  headRefName: "jaysonboyer/proj-999",
  updatedAt: "2026-07-10T00:00:00Z",
  author: { login: "someoneelse" },
  labels: [{ name: "ready-for-human-approval" }, { name: "bug" }],
  reviewDecision: "CHANGES_REQUESTED",
  mergeStateStatus: "BEHIND",
  statusCheckRollup: [{ conclusion: "FAILURE" }],
};
const pr = prFromView(view, "jaysonboyer");
assert.equal(pr.repo, "econx", "repo parsed from url");
assert.equal(pr.number, 1234, "number");
assert.equal(pr.changesRequested, true, "reviewDecision CHANGES_REQUESTED");
assert.equal(pr.outOfDate, true, "mergeStateStatus BEHIND");
assert.equal(pr.failingChecks, 1, "one failing check");
assert.equal(pr.hasApprovalLabel, true, "approval label present");
assert.equal(pr.jiraKey, "PROJ-999", "jira key parsed from title");
assert.deepEqual(pr.labels, ["ready-for-human-approval", "bug"], "label names");

const clean = prFromView({ ...view, mergeStateStatus: "UNKNOWN", reviewDecision: "APPROVED" }, "me");
assert.equal(clean.outOfDate, false, "UNKNOWN is not flagged out-of-date");
assert.equal(clean.changesRequested, false, "APPROVED is not changes-requested");

const stub = prFromView({ url: "https://github.com/sandbox/web-v2/pull/77", unavailable: true }, "me");
assert.equal(stub.repo, "web-v2", "unavailable stub still knows repo from url");
assert.equal(stub.number, 77, "unavailable stub knows number from url");
assert.equal(stub.title, "(details unavailable)", "unavailable stub title");
console.log("✓ prFromView");

// 4. Section split: mine keeps my PRs; others excludes me + drops stale.
const mineView = { ...view, url: "https://github.com/sandbox/econx/pull/1", author: { login: "jaysonboyer" } };
const otherFresh = { ...view, url: "https://github.com/sandbox/econx/pull/2", author: { login: "coworker" } };
const otherIsMe = { ...view, url: "https://github.com/sandbox/econx/pull/3", author: { login: "jaysonboyer" } };
const otherStale = { ...view, url: "https://github.com/sandbox/econx/pull/4", author: { login: "coworker" }, updatedAt: "2026-01-01T00:00:00Z" };
const res = assembleOpenPrs([mineView], [otherFresh, otherIsMe, otherStale], "jaysonboyer", now);
assert.equal(res.me, "jaysonboyer");
assert.deepEqual(res.mine.map((p) => p.number), [1], "mine section");
assert.deepEqual(res.others.map((p) => p.number), [2], "others: excludes me (3) and stale (4)");
assert.equal(APPROVAL_LABEL, "ready-for-human-approval", "label constant");
console.log("✓ assembleOpenPrs");

// 5. Markdown config invariant: raw HTML escaped, bare URL linkified.
const html = renderMarkdown("<script>alert(1)</script>\nsee https://example.com");
assert.ok(!html.includes("<script>"), "raw <script> must not pass through");
assert.ok(html.includes("&lt;script&gt;"), "raw HTML is escaped (html:false)");
assert.ok(html.includes('href="https://example.com"'), "bare URL linkified");
console.log("✓ renderMarkdown config");

console.log("ALL PASS");
process.exit(0);
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && npm run build:server && node lib/open-prs.smoke.mjs
```
Expected: FAIL — `countFailingChecks` (and the other new exports) are `undefined`, so the first `assert.equal(countFailingChecks(...))` throws `TypeError: countFailingChecks is not a function`.

- [ ] **Step 3: Implement the model + pure helpers**

In `apps/mcp-workspace/lib/sandbox.ts`, immediately after the `getWorkspacePRs` function (after the closing `}` at ~line 1272), insert:
```ts
// ---- Open Pull Requests across the org (dashboard "Open Pull Requests" tab) ----

/**
 * The label the `pr-approve-triage` skill keys on. Defined once here so section 2
 * of the Open PRs tab and the per-PR `hasApprovalLabel` flag agree, and it's
 * trivial to change if the org convention differs.
 */
export const APPROVAL_LABEL = "ready-for-human-approval";

/** A PR as shown in the Open Pull Requests tab. */
export interface OpenPr {
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
  changesRequested: boolean;
  failingChecks: number;
  outOfDate: boolean;
  hasApprovalLabel: boolean;
  jiraKey: string | null;
}

export interface OpenPrsResult {
  me: string;
  mine: OpenPr[];
  others: OpenPr[];
}

/** The subset of `gh pr view --json …` we read. */
interface PrView {
  url: string;
  number?: number;
  title?: string;
  body?: string;
  headRefName?: string;
  updatedAt?: string;
  author?: { login?: string };
  labels?: Array<{ name?: string }>;
  reviewDecision?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: unknown;
}

/** A resolved view, or a stub when that PR's `gh pr view` failed (degrade in place). */
type ViewResult = PrView | { url: string; unavailable: true };

// Terminal check conclusions that mean "failing". Explicit set (the spec's
// enumerated examples) rather than "anything not SUCCESS/NEUTRAL/SKIPPED" so an
// in-progress/queued check is never miscounted as a failure.
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

/** Count failing checks in a `statusCheckRollup` (CheckRun `conclusion` or StatusContext `state`). */
export function countFailingChecks(rollup: unknown): number {
  if (!Array.isArray(rollup)) return 0;
  let n = 0;
  for (const c of rollup) {
    if (!c || typeof c !== "object") continue;
    const e = c as { conclusion?: unknown; state?: unknown };
    const verdict = String(e.conclusion ?? e.state ?? "").toUpperCase();
    if (FAILING_CONCLUSIONS.has(verdict)) n++;
  }
  return n;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** True if `updatedAt` is within the last 30 days of `nowMs`. Missing/unparseable → kept. */
export function isWithin30Days(updatedAt: string | undefined, nowMs: number): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t < THIRTY_DAYS_MS;
}

/** `https://github.com/<owner>/<repo>/pull/<n>` → `{ repo, number }`. */
function parseRepoAndNumber(url: string): { repo: string; number: number } {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean); // [owner, repo, "pull", n]
    return { repo: parts[1] ?? "", number: Number.parseInt(parts[3] ?? "", 10) || 0 };
  } catch {
    return { repo: "", number: 0 };
  }
}

/** Map a `gh pr view` object (or unavailable stub) to an OpenPr. */
export function prFromView(v: ViewResult, _meLogin: string): OpenPr {
  const { repo, number } = parseRepoAndNumber(v.url);
  if ("unavailable" in v) {
    return {
      url: v.url,
      repo,
      number,
      title: "(details unavailable)",
      author: "",
      body: "",
      labels: [],
      changesRequested: false,
      failingChecks: 0,
      outOfDate: false,
      hasApprovalLabel: false,
      jiraKey: null,
    };
  }
  const labels = (v.labels ?? []).map((l) => l.name ?? "").filter(Boolean);
  const title = v.title ?? "";
  const body = v.body ?? "";
  return {
    url: v.url,
    repo,
    number: v.number ?? number,
    title,
    author: v.author?.login ?? "",
    body,
    labels,
    changesRequested: v.reviewDecision === "CHANGES_REQUESTED",
    failingChecks: countFailingChecks(v.statusCheckRollup),
    outOfDate: v.mergeStateStatus === "BEHIND",
    hasApprovalLabel: labels.includes(APPROVAL_LABEL),
    jiraKey: parseJiraKey(`${title} ${body} ${v.headRefName ?? ""}`),
  };
}

/**
 * Split the two search result sets into the tab's two sections: `mine` (my open
 * PRs) and `others` (the ready-for-approval queue), applying the 30-day cutoff to
 * both and excluding my own PRs from `others` (they already appear in `mine`).
 */
export function assembleOpenPrs(
  mineViews: ViewResult[],
  labelViews: ViewResult[],
  me: string,
  nowMs: number,
): OpenPrsResult {
  const fresh = (vs: ViewResult[]) =>
    vs.filter((v) => isWithin30Days("unavailable" in v ? undefined : v.updatedAt, nowMs));
  const mine = fresh(mineViews).map((v) => prFromView(v, me));
  const others = fresh(labelViews)
    .map((v) => prFromView(v, me))
    .filter((p) => p.author !== me);
  return { me, mine, others };
}
```

- [ ] **Step 4: Run the smoke test to confirm it passes**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && npm run build:server && node lib/open-prs.smoke.mjs
```
Expected: prints each `✓` line then `ALL PASS`.

- [ ] **Step 5: Commit**
```bash
cd /Users/jayboyer/workspace/sandbox && git add apps/mcp-workspace/lib/sandbox.ts apps/mcp-workspace/lib/open-prs.smoke.mjs && git commit -m "feat(mcp-workspace): Open PRs pure model + classifiers with smoke test"
```

---

### Task 3: `gh`/`claude`/Terminal shell-outs

**Files:**
- Modify: `apps/mcp-workspace/lib/sandbox.ts` (append `getOpenPrs` + private `gh` helpers after Task 2's block; add `fetchJiraIssue`; refactor `resumeClaudeInTerminal` at ~line 2111 and add `openTerminalRunning` + `openTriageTerminal`)

**Interfaces:**
- Consumes: `runCapture`, `stripAnsi`, `extractResult`, `resolveClaudeBin`, `resolveSandboxBin`, `execFileAsync`, `WorkspaceError`, `parseJiraKey`, `JIRA_CLOUD_ID`, `withCache` (from `./cache.js`), and Task 2's `APPROVAL_LABEL` / `ViewResult` / `assembleOpenPrs`.
- Produces:
  - `getOpenPrs(): Promise<OpenPrsResult>`
  - `approvePr(url: string): Promise<{ ok: true }>`
  - `interface JiraCard { key: string; summary?: string; status?: string; type?: string; assignee?: string; description?: string; url?: string }`
  - `fetchJiraIssue(ref: string): Promise<JiraCard>`
  - `openTriageTerminal(url: string): Promise<{ ok: true }>`
  - (internal) `openTerminalRunning(script: string): Promise<void>`

- [ ] **Step 1: Confirm `withCache` is imported**

At the top of `sandbox.ts`, check the `./cache.js` import. If `withCache` is not already imported, add it:
```ts
import { cacheSet, withCache } from "./cache.js";
```
(The existing import already pulls `cacheSet`; extend the same statement. Verify with: `grep -n "from \"./cache.js\"" lib/sandbox.ts`.)

- [ ] **Step 2: Add `getOpenPrs` + `gh` helpers**

Append after Task 2's `assembleOpenPrs` in `sandbox.ts`:
```ts
/** `gh api user --jq .login` — the current GitHub login. Throws if gh isn't authed. */
async function resolveGithubLogin(): Promise<string> {
  const res = await runCapture("gh", ["api", "user", "--jq", ".login"]).catch(() => null);
  const login = res && res.code === 0 ? stripAnsi(res.stdout).trim() : "";
  if (!login) {
    throw new WorkspaceError("Could not resolve GitHub user (`gh api user`). Is `gh` authenticated?");
  }
  return login;
}

/** Open-PR URLs from one `gh search prs` query (org + open-state are always applied). */
async function ghSearchPrUrls(filters: string[]): Promise<string[]> {
  const res = await runCapture("gh", [
    "search",
    "prs",
    "--owner=sandbox",
    "--state=open",
    ...filters,
    "--json",
    "url",
    "--limit",
    "100",
  ]);
  if (res.code !== 0) {
    throw new WorkspaceError(`gh search prs failed: ${stripAnsi(res.stderr).trim() || `exit ${res.code}`}`);
  }
  try {
    const arr = JSON.parse(stripAnsi(res.stdout).trim() || "[]") as Array<{ url?: string }>;
    return arr.map((x) => x.url).filter((u): u is string => !!u);
  } catch {
    return [];
  }
}

/** `gh pr view <url> --json …` → a PrView, or an unavailable stub on any failure. */
async function ghPrView(url: string): Promise<ViewResult> {
  const res = await runCapture("gh", [
    "pr",
    "view",
    url,
    "--json",
    "reviewDecision,mergeStateStatus,statusCheckRollup,labels,author,number,title,body,headRefName,updatedAt,url",
  ]).catch(() => null);
  if (!res || res.code !== 0) return { url, unavailable: true };
  try {
    return JSON.parse(stripAnsi(res.stdout).trim()) as PrView;
  } catch {
    return { url, unavailable: true };
  }
}

/**
 * The Open Pull Requests tab's data: my open PRs + others' ready-for-approval PRs
 * (younger than 30 days), each enriched with review/check/label state.
 *
 * Two `gh search prs` calls give the URL sets; a `gh pr view` fan-out enriches
 * each. ponytail: no concurrency cap on the fan-out (matches getWorkspacePRs),
 * bounded in practice by my-open-PRs + the approval queue — add a cap if either
 * grows large.
 */
export async function getOpenPrs(): Promise<OpenPrsResult> {
  const me = await resolveGithubLogin();
  const [mineUrls, labelUrls] = await Promise.all([
    ghSearchPrUrls(["--author=@me"]),
    ghSearchPrUrls([`--label=${APPROVAL_LABEL}`]),
  ]);
  const [mineViews, labelViews] = await Promise.all([
    Promise.all(mineUrls.map(ghPrView)),
    Promise.all(labelUrls.map(ghPrView)),
  ]);
  return assembleOpenPrs(mineViews, labelViews, me, Date.now());
}

/** Approve a PR: `gh pr review <url> --approve`. No label change. */
export async function approvePr(url: string): Promise<{ ok: true }> {
  const res = await runCapture("gh", ["pr", "review", url, "--approve"]);
  if (res.code !== 0) {
    throw new WorkspaceError(`gh pr review failed: ${stripAnsi(res.stderr).trim() || `exit ${res.code}`}`);
  }
  return { ok: true };
}
```

- [ ] **Step 3: Add `fetchJiraIssue`**

Append in `sandbox.ts` (near the other Jira helpers is fine; keeping it in the Open-PRs block is also fine):
```ts
/** A compact Jira card for the reconcile inline view. `key` always present. */
export interface JiraCard {
  key: string;
  summary?: string;
  status?: string;
  type?: string;
  assignee?: string;
  description?: string;
  url?: string;
}

const JIRA_CARD_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch a compact Jira card for `ref` (a key or any string containing one),
 * best-effort. Same claude -p + extractJson + persistent-cache path as
 * {@link fetchJiraFormData} / {@link getJiraStatuses}. Never throws to the
 * caller: on any failure returns `{ key }` alone so the triage launch is never
 * blocked.
 */
export async function fetchJiraIssue(ref: string): Promise<JiraCard> {
  const key = parseJiraKey(ref) ?? ref.trim();
  if (!key) return { key: "" };
  const card = await withCache<JiraCard>(`jira-card:${key.toUpperCase()}`, JIRA_CARD_TTL_MS, async () => {
    const prompt =
      "You are a data extractor, not an agent. Do exactly two things and nothing else:\n" +
      `1. Fetch Jira issue ${key} using getJiraIssue (Atlassian cloud id ${JIRA_CLOUD_ID}) — ` +
      'request fields ["summary","status","issuetype","assignee","description"].\n' +
      "2. Output ONLY a JSON object between <result> and </result> tags with keys: " +
      '"key","summary","status","type","assignee","description","url". Use empty strings for ' +
      "anything unavailable. Do not create, edit, transition, or comment on anything; write no " +
      "prose outside the tags.\n" +
      `If you cannot fetch the issue, output <result>{"key":"${key}"}</result> and nothing else.`;
    try {
      const bin = await resolveClaudeBin();
      const res = await runCapture(bin, ["-p", prompt, "--dangerously-skip-permissions"]);
      if (res.code !== 0) return { key };
      const json = extractJson(extractResult(stripAnsi(res.stdout)));
      if (!json) return { key };
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
      return {
        key: str(parsed.key) ?? key,
        summary: str(parsed.summary),
        status: str(parsed.status),
        type: str(parsed.type),
        assignee: str(parsed.assignee),
        description: str(parsed.description),
        url: str(parsed.url),
      };
    } catch {
      return { key };
    }
  });
  return card ?? { key };
}
```

- [ ] **Step 4: Factor out `openTerminalRunning` and add `openTriageTerminal`**

Replace the body of `resumeClaudeInTerminal` (`sandbox.ts:2111-2136`) so it delegates the `osascript` core to a new shared helper, and add the helper + `openTriageTerminal`:
```ts
/**
 * Open a macOS Terminal window running `script` (a shell command line) and bring
 * Terminal to the front. The AppleScript-embedding escape is applied here.
 * Factored out of {@link resumeClaudeInTerminal} so the PR triage launch reuses it.
 */
async function openTerminalRunning(script: string): Promise<void> {
  // Escape for embedding inside an AppleScript double-quoted string.
  const osaScript = script.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    await execFileAsync("osascript", [
      "-e",
      `tell application "Terminal" to do script "${osaScript}"`,
      "-e",
      'tell application "Terminal" to activate',
    ]);
  } catch (e) {
    throw new WorkspaceError(`Could not open Terminal: ${(e as Error).message}`);
  }
}

export async function resumeClaudeInTerminal(
  name: string,
  sessionId?: string,
): Promise<{ path: string; sessionId: string | null }> {
  const target = await resolveWorkspaceDir(name);
  const transcript = await getClaudeTranscript(name, 1, sessionId);
  const claudeCmd = transcript.sessionId ? `claude --resume ${transcript.sessionId}` : "claude";
  // Single-quote the path for the shell; escape any embedded single quotes.
  const shellPath = `'${target.replace(/'/g, `'\\''`)}'`;
  await openTerminalRunning(`cd ${shellPath} && ${claudeCmd}`);
  return { path: target, sessionId: transcript.sessionId };
}

/**
 * Open a macOS Terminal running `claude "/pr-approve-triage <url>"`, cd'd to the
 * sandbox repo root. The pr-approve-triage skill is global, so the cwd
 * only needs to be a valid repo. ponytail: url is a github URL (no shell-special
 * chars); the AppleScript escape in openTerminalRunning covers quotes/backslashes.
 */
export async function openTriageTerminal(url: string): Promise<{ ok: true }> {
  const repoRoot = path.dirname(await resolveSandboxBin());
  const shellPath = `'${repoRoot.replace(/'/g, `'\\''`)}'`;
  await openTerminalRunning(`cd ${shellPath} && claude "/pr-approve-triage ${url}"`);
  return { ok: true };
}
```

- [ ] **Step 5: Typecheck, build, and re-run the smoke test (guards the refactor)**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && npm run build:server && node lib/open-prs.smoke.mjs
```
Expected: compiles clean; smoke test still prints `ALL PASS` (the pure helpers are unchanged; this confirms the new shell-out code didn't break the build).

- [ ] **Step 6: Commit**
```bash
cd /Users/jayboyer/workspace/sandbox && git add apps/mcp-workspace/lib/sandbox.ts && git commit -m "feat(mcp-workspace): getOpenPrs/approvePr/fetchJiraIssue + Terminal triage launch"
```

---

### Task 4: Register the four server tools

**Files:**
- Modify: `apps/mcp-workspace/server.ts` (imports block ~line 28; add four `server.registerTool` blocks after the `jira-statuses` tool, ~line 586)

**Interfaces:**
- Consumes: `getOpenPrs`, `approvePr`, `fetchJiraIssue`, `openTriageTerminal` from `./lib/sandbox.js`.
- Produces (MCP tools): `open-prs`, `pr-approve`, `jira-issue`, `pr-triage`.

- [ ] **Step 1: Extend the sandbox import**

In `server.ts`, add the four names to the existing `import { … } from "./lib/sandbox.js";` block (alphabetical-ish, matching the existing style):
```ts
  approvePr,
  fetchJiraIssue,
  getOpenPrs,
  openTriageTerminal,
```

- [ ] **Step 2: Register the four tools**

In `server.ts`, immediately after the `jira-statuses` tool's closing `);` (~line 586), insert:
```ts
  // --- Tool: open PRs across the org (dashboard "Open Pull Requests" tab) -----
  server.registerTool(
    "open-prs",
    {
      title: "Open Pull Requests",
      description:
        "List open PRs across the sandbox org (younger than 30 days): my own PRs and other " +
        "members' ready-for-human-approval PRs, each with review/check/label state and its Jira " +
        "key. Best-effort — a PR whose details can't be read degrades to a stub card.",
      inputSchema: {},
      outputSchema: z.object({
        me: z.string(),
        mine: z.array(z.any()),
        others: z.array(z.any()),
      }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await getOpenPrs();
        const text = `Open PRs — mine: ${result.mine.length}, ready-for-approval: ${result.others.length}.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: approve a PR (gh pr review --approve; no label change) -----------
  server.registerTool(
    "pr-approve",
    {
      title: "Approve Pull Request",
      description: "Approve a pull request via `gh pr review <url> --approve`. Does not change labels.",
      inputSchema: { url: z.string().describe("The pull request URL.") },
      outputSchema: z.object({ ok: z.literal(true) }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await approvePr(args.url);
        return {
          content: [{ type: "text", text: `Approved ${args.url}.` }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: fetch a compact Jira card (best-effort) --------------------------
  server.registerTool(
    "jira-issue",
    {
      title: "Jira Issue Card",
      description:
        "Fetch a compact Jira card (key, summary, status, type, assignee, description, url) for a " +
        "ticket key or any string containing one. Best-effort: returns `{ key }` alone if the " +
        "lookup fails.",
      inputSchema: { ref: z.string().describe("A Jira key (e.g. PROJ-1234) or a string containing one.") },
      outputSchema: z.object({
        key: z.string(),
        summary: z.string().optional(),
        status: z.string().optional(),
        type: z.string().optional(),
        assignee: z.string().optional(),
        description: z.string().optional(),
        url: z.string().optional(),
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await fetchJiraIssue(args.ref);
        const text = result.summary ? `${result.key}: ${result.summary}` : result.key || "No ticket.";
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: open a Terminal running the pr-approve-triage skill --------------
  server.registerTool(
    "pr-triage",
    {
      title: "Open PR Triage Terminal",
      description:
        "Open a macOS Terminal running `claude \"/pr-approve-triage <url>\"` in the sandbox " +
        "repo, for interactive PR reconcile/approve/reject.",
      inputSchema: { url: z.string().describe("The pull request URL to triage.") },
      outputSchema: z.object({ ok: z.literal(true) }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await openTriageTerminal(args.url);
        return {
          content: [{ type: "text", text: `Opened Terminal running /pr-approve-triage for ${args.url}.` }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );
```

- [ ] **Step 3: Typecheck + build**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && npm run build:server
```
Expected: compiles clean.

- [ ] **Step 4: Smoke-test the `open-prs` dispatch end-to-end (real `gh`)**

Run (exercises the real tool over the same in-memory path the browser uses; requires `gh` authed):
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && node -e "import('./dist/lib/sandbox.js').then(async m=>{const r=await m.getOpenPrs(); console.log('me',r.me,'mine',r.mine.length,'others',r.others.length); console.log(JSON.stringify(r.mine[0]??r.others[0]??{}, null, 2));})"
```
Expected: prints your login and two counts, plus one PR object showing the computed flags. (If `gh` isn't authed it throws the WorkspaceError from `resolveGithubLogin` — that's the correct error path.)

- [ ] **Step 5: Commit**
```bash
cd /Users/jayboyer/workspace/sandbox && git add apps/mcp-workspace/server.ts && git commit -m "feat(mcp-workspace): register open-prs/pr-approve/jira-issue/pr-triage tools"
```

---

### Task 5: The `prs-ui.ts` tab

**Files:**
- Create: `apps/mcp-workspace/src/prs-ui.ts`

**Interfaces:**
- Consumes: `HostBridge` from `./workspace-ui.js`; `renderMarkdown` from `../lib/markdown.js`; tools `open-prs`, `pr-approve`, `jira-issue`, `pr-triage`.
- Produces: `initPrsUI(bridge: HostBridge, root: HTMLElement): { reload: () => void }`.

- [ ] **Step 1: Write the tab UI**

Create `apps/mcp-workspace/src/prs-ui.ts`:
```ts
/**
 * "Open Pull Requests" dashboard tab. Dependency-free vanilla DOM (same `el()` +
 * CSS-injection approach as workspace-ui.ts). Two sections — my open PRs and the
 * ready-for-approval queue — each an expandable card. Expanding renders the PR
 * body via markdown-it (html:false) and shows an Approve button plus, when the PR
 * carries the approval label, a Reconcile-with-Jira → Terminal-triage flow.
 *
 * Browser surface only (needs the same-origin Express server for its Terminal +
 * Jira tools); not mounted by mcp-list.ts or artifact-main.ts.
 */
import type { HostBridge } from "./workspace-ui.js";
import { renderMarkdown } from "../lib/markdown.js";

interface OpenPr {
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
  changesRequested: boolean;
  failingChecks: number;
  outOfDate: boolean;
  hasApprovalLabel: boolean;
  jiraKey: string | null;
}
interface OpenPrsResult {
  me: string;
  mine: OpenPr[];
  others: OpenPr[];
}
interface JiraCard {
  key: string;
  summary?: string;
  status?: string;
  type?: string;
  assignee?: string;
  description?: string;
  url?: string;
}

const CSS = `
  .prs, .prs * { box-sizing: border-box; }
  .prs {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a1a1a; padding: 16px 20px 40px;
  }
  .prs .controls { display: flex; align-items: center; gap: 10px; margin: 4px 0 16px; }
  .prs .controls input[type=search] {
    flex: 1; font: inherit; font-size: 13px; padding: 7px 10px;
    border: 1px solid #d9d9d4; border-radius: 8px; background: #fff;
  }
  .prs .refresh {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    padding: 7px 12px; border: 1px solid #d9d9d4; border-radius: 8px; background: #fff; color: #1a1a1a;
  }
  .prs .refresh:hover { background: #f2f2ef; }
  .prs .load-status { color: #6b6b66; font-size: 13px; padding: 8px 0; }
  .prs .load-status.err { color: #c0392b; }
  .prs .sec-h { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    color: #6b6b66; margin: 20px 0 8px; }
  .prs .sec-h .count { color: #b0b0a8; font-weight: 600; margin-left: 6px; }
  .prs .sec-empty { color: #9a9a92; font-size: 13px; padding: 4px 0 8px; }
  .prs .card { border: 1px solid #e5e5e0; border-radius: 10px; background: #fff; margin-bottom: 8px; }
  .prs .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 12px; cursor: pointer; }
  .prs .head:hover { background: #faf9f7; }
  .prs .repo { font-weight: 700; font-size: 13px; }
  .prs .num { color: #6b6b66; font-size: 13px; }
  .prs .ttl { font-size: 13px; flex: 1; min-width: 160px; }
  .prs .lbl { font-size: 10px; background: #fff4e5; color: #b76a00; padding: 1px 6px; border-radius: 4px; }
  .prs .pr-flag { font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 600; }
  .prs .pr-flag.changes { background: #fdecea; color: #c0392b; }
  .prs .pr-flag.failing { background: #fdecea; color: #c0392b; }
  .prs .pr-flag.stale { background: #fef6e0; color: #9a6a00; }
  .prs .panel { border-top: 1px solid #f0efeb; padding: 12px 14px; }
  .prs .panel[hidden] { display: none; }
  .prs .body { font-size: 13px; line-height: 1.5; overflow-x: auto; }
  .prs .body pre { background: #f6f6f3; padding: 10px; border-radius: 6px; overflow-x: auto; }
  .prs .body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .prs .body table { border-collapse: collapse; }
  .prs .body td, .prs .body th { border: 1px solid #e5e5e0; padding: 4px 8px; }
  .prs .actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .prs .btn {
    font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    padding: 6px 12px; border-radius: 7px; border: 1px solid #d9d9d4; background: #fff; color: #1a1a1a;
  }
  .prs .btn:hover { background: #f2f2ef; }
  .prs .btn.primary { background: #1e7a46; border-color: #1e7a46; color: #fff; }
  .prs .btn.primary:hover { background: #1a6b3d; }
  .prs .btn[disabled] { opacity: .55; cursor: default; }
  .prs .act-msg { font-size: 12px; color: #6b6b66; margin-left: auto; }
  .prs .act-msg.err { color: #c0392b; }
  .prs .act-msg.ok { color: #1e7a46; }
  .prs .jira { margin-top: 12px; border: 1px solid #dbe4 f0; border-radius: 8px;
    background: #f4f8fd; padding: 10px 12px; font-size: 12px; }
  .prs .jira .k { font-weight: 700; }
  .prs .jira .st { font-size: 10px; background: #e3edfa; color: #2a5b93;
    padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
  .prs .jira .meta { color: #6b6b66; margin-top: 4px; }
  .prs .jira .desc { margin-top: 6px; white-space: pre-wrap; color: #444; }
`;

export function initPrsUI(bridge: HostBridge, root: HTMLElement): { reload: () => void } {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  root.classList.add("prs");
  root.innerHTML = `
    <div class="controls">
      <input type="search" data-id="filter" placeholder="Filter by title, repo, or label…">
      <button class="refresh" data-id="refresh">↻ Refresh</button>
    </div>
    <div class="load-status" data-id="status">Loading pull requests…</div>
    <div data-id="mine"></div>
    <div data-id="others"></div>`;

  const $ = (id: string) => root.querySelector(`[data-id="${id}"]`) as HTMLElement;
  const call = (tool: string, args?: Record<string, unknown>) => bridge.callTool(tool, args);

  function el(tag: string, cls?: string | null, txt?: string | null): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  let data: OpenPrsResult | null = null;
  let filter = "";

  function matches(pr: OpenPr): boolean {
    if (!filter) return true;
    const hay = `${pr.repo} ${pr.number} ${pr.title} ${pr.labels.join(" ")}`.toLowerCase();
    return hay.includes(filter);
  }

  function chips(pr: OpenPr): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (pr.changesRequested) out.push(el("span", "pr-flag changes", "changes requested"));
    if (pr.failingChecks > 0) out.push(el("span", "pr-flag failing", `${pr.failingChecks} failing`));
    if (pr.outOfDate) out.push(el("span", "pr-flag stale", "out of date"));
    for (const l of pr.labels) out.push(el("span", "lbl", l));
    return out;
  }

  function renderJiraCard(c: JiraCard): HTMLElement {
    const box = el("div", "jira");
    const line = el("div");
    line.appendChild(el("span", "k", c.key));
    if (c.summary) line.appendChild(document.createTextNode(` ${c.summary}`));
    if (c.status) line.appendChild(el("span", "st", c.status));
    box.appendChild(line);
    const metaBits = [c.type, c.assignee ? `@${c.assignee}` : ""].filter(Boolean).join(" · ");
    if (metaBits) box.appendChild(el("div", "meta", metaBits));
    if (c.description) box.appendChild(el("div", "desc", c.description));
    return box;
  }

  function buildCard(pr: OpenPr): HTMLElement {
    const card = el("div", "card");
    const head = el("div", "head");
    head.appendChild(el("span", "repo", pr.repo));
    head.appendChild(el("span", "num", `#${pr.number}`));
    head.appendChild(el("span", "ttl", pr.title));
    chips(pr).forEach((c) => head.appendChild(c));

    const panel = el("div", "panel");
    panel.hidden = true;
    const body = el("div", "body");
    body.innerHTML = renderMarkdown(pr.body || "_No description._");
    panel.appendChild(body);

    const actions = el("div", "actions");
    const approveBtn = el("button", "btn primary", "Approve") as HTMLButtonElement;
    const msg = el("span", "act-msg");
    actions.appendChild(approveBtn);

    let reconcileBtn: HTMLButtonElement | null = null;
    if (pr.hasApprovalLabel) {
      reconcileBtn = el("button", "btn", "Reconcile with Jira") as HTMLButtonElement;
      actions.appendChild(reconcileBtn);
    }
    actions.appendChild(msg);
    panel.appendChild(actions);
    card.appendChild(head);
    card.appendChild(panel);

    head.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
    });

    approveBtn.addEventListener("click", async () => {
      approveBtn.disabled = true;
      msg.className = "act-msg";
      msg.textContent = "Approving…";
      try {
        await call("pr-approve", { url: pr.url });
        msg.className = "act-msg ok";
        msg.textContent = "approved ✓";
      } catch (e) {
        msg.className = "act-msg err";
        msg.textContent = (e as Error).message || "approve failed";
        approveBtn.disabled = false;
      }
    });

    reconcileBtn?.addEventListener("click", async () => {
      reconcileBtn!.disabled = true;
      msg.className = "act-msg";
      msg.textContent = "Reading Jira ticket…";
      // 1. Best-effort Jira card; a failure shows a note and does not block triage.
      try {
        const cardData = (await call("jira-issue", { ref: pr.jiraKey ?? pr.title })) as JiraCard;
        if (cardData && cardData.key) panel.insertBefore(renderJiraCard(cardData), actions);
      } catch {
        panel.insertBefore(el("div", "jira", "couldn't read ticket"), actions);
      }
      // 2. Launch the interactive triage Terminal.
      msg.textContent = "Opening Terminal for triage…";
      try {
        await call("pr-triage", { url: pr.url });
        msg.className = "act-msg ok";
        msg.textContent = "Terminal opened — triage running there.";
      } catch (e) {
        msg.className = "act-msg err";
        msg.textContent = (e as Error).message || "couldn't open Terminal";
        reconcileBtn!.disabled = false;
      }
    });

    return card;
  }

  function renderSection(host: HTMLElement, label: string, prs: OpenPr[]): void {
    host.innerHTML = "";
    const shown = prs.filter(matches);
    const h = el("div", "sec-h", label);
    h.appendChild(el("span", "count", String(shown.length)));
    host.appendChild(h);
    if (!shown.length) {
      host.appendChild(el("div", "sec-empty", "Nothing here."));
      return;
    }
    shown.forEach((pr) => host.appendChild(buildCard(pr)));
  }

  function render(): void {
    if (!data) return;
    $("status").style.display = "none";
    renderSection($("mine"), "My open PRs", data.mine);
    renderSection($("others"), "Ready for review", data.others);
  }

  async function load(): Promise<void> {
    const status = $("status");
    status.style.display = "";
    status.className = "load-status";
    status.textContent = "Loading pull requests…";
    $("mine").innerHTML = "";
    $("others").innerHTML = "";
    try {
      data = (await call("open-prs")) as OpenPrsResult;
      render();
    } catch (e) {
      status.className = "load-status err";
      status.textContent = `Couldn't load pull requests: ${(e as Error).message}. `;
      const retry = el("button", "refresh", "Retry");
      retry.addEventListener("click", () => void load());
      status.appendChild(retry);
    }
  }

  ($("filter") as HTMLInputElement).addEventListener("input", (ev) => {
    filter = (ev.target as HTMLInputElement).value.trim().toLowerCase();
    if (data) render();
  });
  $("refresh").addEventListener("click", () => void load());

  void load();
  return { reload: () => void load() };
}
```

- [ ] **Step 2: Typecheck + build the browser bundle**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && npm run build
```
Expected: `tsc --noEmit` passes (prs-ui.ts typechecks against `HostBridge` and `renderMarkdown`), vite bundles `browser.html` including `markdown-it`, and `build:server` compiles. (Note: fix the CSS typo `#dbe4 f0` → `#dbe4f0` in the `.jira` border rule if your editor flagged it — it renders regardless but should be clean.)

- [ ] **Step 3: Commit**
```bash
cd /Users/jayboyer/workspace/sandbox && git add apps/mcp-workspace/src/prs-ui.ts && git commit -m "feat(mcp-workspace): Open Pull Requests tab UI (prs-ui.ts)"
```

---

### Task 6: Wire the third tab into `browser-main.ts`

**Files:**
- Modify: `apps/mcp-workspace/src/browser-main.ts`

**Interfaces:**
- Consumes: `initPrsUI` from `./prs-ui.js`.
- Produces: a `#prs` route + lazy-mounted `Open Pull Requests` tab.

- [ ] **Step 1: Import the tab**

After the existing `import { initCreateForm } from "./create-form.js";` (line 15) add:
```ts
import { initPrsUI } from "./prs-ui.js";
```

- [ ] **Step 2: Add the tab button + pane to the shell markup**

In the `root.innerHTML` template (lines 79-89), add the button after the "New workspace" button and the pane after the `new` pane:
```ts
root.innerHTML = `
  <div class="wsd-header wsd-container" data-id="shell-header"></div>
  <div class="wsd-tabs">
    <div class="wsd-tabrow wsd-container">
      <button class="wsd-tab active" data-tab="list">Workspaces</button>
      <button class="wsd-tab" data-tab="new">New workspace</button>
      <button class="wsd-tab" data-tab="prs">Open Pull Requests</button>
    </div>
  </div>
  <div class="wsd-pane wsd-container" data-pane="list"></div>
  <div class="wsd-pane wsd-container" data-pane="new" hidden></div>
  <div class="wsd-pane wsd-container" data-pane="prs" hidden></div>
`;
```

- [ ] **Step 3: Grab the new pane element**

After `const newPane = root.querySelector('[data-pane="new"]') as HTMLElement;` (line 93) add:
```ts
const prsPane = root.querySelector('[data-pane="prs"]') as HTMLElement;
```

- [ ] **Step 4: Add lazy-mount state**

After `let createMounted = false;` (line 99) add:
```ts
let prsMounted = false;
let prs: { reload: () => void } | null = null;
```

- [ ] **Step 5: Extend the tab type + `show()`**

Replace the `show` function (lines 106-120) with the three-tab version:
```ts
function show(tab: "list" | "new" | "prs"): void {
  tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  listPane.hidden = tab !== "list";
  newPane.hidden = tab !== "new";
  prsPane.hidden = tab !== "prs";
  document.title =
    tab === "new"
      ? "New workspace · Sandbox Workspaces"
      : tab === "prs"
        ? "Open Pull Requests · Sandbox Workspaces"
        : "Sandbox Workspaces";
  if (tab === "new" && !createMounted) {
    createMounted = true;
    initCreateForm(bridge, newPane, {
      onCreated: () => {
        list.reload();
        navigate("list");
      },
    });
  }
  if (tab === "prs" && !prsMounted) {
    prsMounted = true;
    prs = initPrsUI(bridge, prsPane);
  }
}
```
(`prs` is assigned for symmetry with `list`/`create`; the tab owns its own Refresh control, so no external `reload()` call is needed yet.)

- [ ] **Step 6: Extend `tabFromHash` + `navigate`**

Replace `tabFromHash` (lines 122-124) and `navigate` (lines 126-131):
```ts
function tabFromHash(): "list" | "new" | "prs" {
  const h = location.hash.replace(/^#/, "");
  return h === "new" ? "new" : h === "prs" ? "prs" : "list";
}

function navigate(tab: "list" | "new" | "prs"): void {
  // Setting the hash adds a history entry and fires hashchange (which renders).
  // If we're already on that hash there's no event, so render directly.
  if (tabFromHash() === tab) show(tab);
  else location.hash = tab;
}
```

- [ ] **Step 7: Update the click handler's cast**

Replace line 133:
```ts
tabs.forEach((b) => b.addEventListener("click", () => navigate(b.dataset.tab as "list" | "new" | "prs")));
```

- [ ] **Step 8: Typecheck + build**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox/apps/mcp-workspace && npm run build
```
Expected: clean typecheck + successful vite + server build.

- [ ] **Step 9: Integration test by hand**

Run the MCP server / dashboard and exercise the tab:
```bash
cd /Users/jayboyer/workspace/sandbox && ./sandbox mcp
```
Then open the browser dashboard, click **Open Pull Requests** (URL should become `…/#prs`, title "Open Pull Requests · Sandbox Workspaces"), and verify:
- both sections load with counts; the filter box narrows by title/repo/label;
- a card expands to show its markdown-rendered body;
- **Approve** on one of your own test PRs shows "approved ✓";
- **Reconcile with Jira** appears only on approval-labelled cards, renders the inline Jira card (or "couldn't read ticket"), then opens a Terminal running `/pr-approve-triage <url>`;
- Back/Forward moves between the three tabs.

- [ ] **Step 10: Commit**
```bash
cd /Users/jayboyer/workspace/sandbox && git add apps/mcp-workspace/src/browser-main.ts && git commit -m "feat(mcp-workspace): add Open Pull Requests tab + #prs route to dashboard"
```

---

## Self-Review

**Spec coverage:**
- Sections & filters (§Sections) → Task 2 `assembleOpenPrs` (split + self-exclusion + cutoff), Task 3 `getOpenPrs` (two `gh search prs` calls with `--author=@me` / `--label`), Task 5 filter box. ✅
- Current-user resolved live via `gh api user --jq .login` → Task 3 `resolveGithubLogin`. ✅
- Per-PR properties table (§Per-PR properties) → Task 2 `prFromView` + `countFailingChecks` (all rows: labels, changesRequested, failingChecks, outOfDate, body; plus hasApprovalLabel, jiraKey). ✅
- `gh pr view` fan-out with the exact `--json` field list → Task 3 `ghPrView`. ✅
- Server tools `open-prs`/`pr-approve`/`jira-issue`/`pr-triage` (§Server tools) → Tasks 3–4. ✅
- `openTerminalRunning` factored out of `resumeClaudeInTerminal`, behavior unchanged → Task 3 Step 4. ✅
- UI (§UI): dependency-free DOM, `initPrsUI(bridge, root)` + `reload()`, tab wiring, `#prs` route, lazy mount, document title, chips, expand, markdown body, actions row, shared message slot, loading/refresh/retry → Tasks 5–6. ✅
- Markdown rendering `html:false` + `linkify:true`, single shared instance → Task 1. ✅
- Error handling (§Error handling): whole-list retry, per-card degrade, action-slot errors with re-enable, best-effort Jira → Tasks 3 (`unavailable` stub, `fetchJiraIssue` fallback) + 5 (retry, `act-msg`, button re-enable). ✅
- Testing (§Testing): `open-prs.smoke.mjs` covering failing-checks classifier, outOfDate, 30-day cutoff, section split/self-exclusion, and the markdown `html:false` invariant → Task 2. ✅
- `package.json` markdown-it dep (+ `@types` dev) → Task 1. ✅

**Placeholder scan:** every code step contains full code; commands include expected output; no "TBD"/"add error handling"/"similar to Task N". The one intentional editor-hint (CSS `#dbe4 f0` typo call-out in Task 5 Step 2) is flagged, not left implicit. ✅

**Type consistency:** `OpenPr`/`OpenPrsResult`/`JiraCard` field names are identical in `sandbox.ts` (Tasks 2–3), the server output schemas (Task 4), and the UI's local interface copies (Task 5). `ViewResult` is produced by `ghPrView` (Task 3) and consumed by `prFromView`/`assembleOpenPrs` (Task 2). `APPROVAL_LABEL` is defined once (Task 2) and consumed in Task 3. `renderMarkdown` signature matches across Tasks 1, 2 (smoke), and 5. `initPrsUI` signature matches between Task 5 (definition) and Task 6 (call). ✅

**Note on file size:** `lib/sandbox.ts` is already ~2100 lines; this plan follows the spec's "all in `sandbox.ts`" decision rather than splitting, because the smoke test imports the pure helpers from `dist/lib/sandbox.js` and the existing tools all live there. A future split into `lib/open-prs.ts` is reasonable if the file keeps growing.
