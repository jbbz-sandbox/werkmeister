# External References Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every org-, person-, and private-codebase-specific value from the repo. Jira, Slack, and GraphQL federation become optional integrations driven by config.

**Architecture:** Code changes are small, local guards and config lookups in `sandbox-core`: a Jira site helper, a required Slack channel, and a supergraph skip. The dashboard gets one new PR field. Everything else is doc and fixture edits plus `git rm` of the experiments folder, the superpowers archive, and committed `.pyc` files.

**Tech Stack:** TypeScript (Node ≥20), `node:test` (sandbox-core, vscode-plugin), vitest (apps/cli), plain-node smoke scripts (dashboard), turbo.

**Spec:** `docs/superpowers/specs/2026-10-04-external-references-cleanup-design.md`

## Global Constraints

- Branch: `jayboyer/external-references-cleanup` (already checked out).
- Placeholders: Jira site `your-org.atlassian.net` in user-facing text, `example.atlassian.net` and `dev@example.com` in tests. The Jira key placeholder is `PROJ-<n>`.
- `<personal-repo>` → `mobile-app`. `/Users/<user>/repos/` → `~/repos/`, any other `/Users/<user>` → `~`.
- Do not touch tier-E items, `apps/cli/dist` (untracked build output), or `external-references-review.md` (stays untracked).
- `sandbox-core` tests import from `dist/`, and the CLI's vitest resolves `sandbox-core` to its `dist/` too. **Run `npm run build -w sandbox-core` before any test that exercises core code.**
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A `jira.base_url` written without a scheme (`acme.atlassian.net`) should still yield a site ref, not null. Covered by Task 1's "scheme-less base_url" test.
- A `jira.base_url` with a trailing slash or path should yield the bare hostname. Covered by Task 1's "base_url hostname" test.
- A PR whose title has a Jira key on a machine with no `jira.base_url` should show the key as text, never a broken link. Covered by Task 2's smoke assertion.
- Slack token set but channel unset should fail with a clear error and send no network request. Covered by Task 4's test, where fetch is stubbed to throw.
- A workspace with a stale `supergraph-config.yml` from an earlier run whose registry no longer has subgraphs should have the file removed. Covered by Task 5's stale-file test.

---

### Task 1: Jira site ref from config (A1)

**Files:**
- Modify: `packages/sandbox-core/issue_tracker.ts` (append after `jiraBrowseUrl`, ~L63)
- Modify: `packages/sandbox-core/sandbox.ts` (import L40; delete `JIRA_CLOUD_ID` L446-447; prompts ~L652, ~L683, ~L716, ~L1860)
- Test: `packages/sandbox-core/jira-site-ref.test.mjs` (create)

**Interfaces:**
- Produces: `jiraSiteRef(): string | null` and `jiraSitePhrase(): string`, both exported from `sandbox-core/issue_tracker`.

- [ ] **Step 1: Write the failing test** — create `packages/sandbox-core/jira-site-ref.test.mjs`:

```js
// How Claude prompts address the Jira site for the Atlassian MCP tools:
// jira.cloud_id, else the jira.base_url hostname, else an instruction to look it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cfg = path.join(mkdtempSync(path.join(tmpdir(), "jira-site-")), "config.yaml");
process.env.SANDBOX_CONFIG_FILE = cfg;
const { jiraSiteRef, jiraSitePhrase } = await import("./dist/issue_tracker.js");

test("cloud_id wins over base_url", () => {
  writeFileSync(cfg, "jira:\n  cloud_id: abc-123\n  base_url: https://acme.atlassian.net/\n");
  assert.equal(jiraSiteRef(), "abc-123");
});

test("base_url hostname when no cloud_id", () => {
  writeFileSync(cfg, "jira:\n  base_url: https://acme.atlassian.net/jira/\n");
  assert.equal(jiraSiteRef(), "acme.atlassian.net");
  assert.equal(jiraSitePhrase(), "(Atlassian cloud id acme.atlassian.net)");
});

test("scheme-less base_url still resolves", () => {
  writeFileSync(cfg, "jira:\n  base_url: acme.atlassian.net\n");
  assert.equal(jiraSiteRef(), "acme.atlassian.net");
});

test("nothing configured → null and a lookup instruction", () => {
  writeFileSync(cfg, "paths: {}\n");
  assert.equal(jiraSiteRef(), null);
  assert.match(jiraSitePhrase(), /getAccessibleAtlassianResources/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run build -w sandbox-core && (cd packages/sandbox-core && node --test jira-site-ref.test.mjs)`
Expected: FAIL with `TypeError: jiraSiteRef is not a function`.

- [ ] **Step 3: Implement.** Append to `packages/sandbox-core/issue_tracker.ts` after `jiraBrowseUrl`:

```ts
/**
 * The Jira site as the Atlassian MCP tools address it: `jira.cloud_id`, else
 * the `jira.base_url` hostname (the tools accept a site URL as cloudId), else null.
 */
export function jiraSiteRef(): string | null {
  const jira = loadJira();
  const id = (jira.cloud_id ?? "").trim();
  if (id) return id;
  const base = (jira.base_url ?? "").trim();
  if (!base) return null;
  try {
    return new URL(base.includes("://") ? base : `https://${base}`).hostname || null;
  } catch {
    return null;
  }
}

/** Prompt phrase naming the Jira site for getJiraIssue / searchJiraIssuesUsingJql. */
export function jiraSitePhrase(): string {
  const ref = jiraSiteRef();
  return ref ? `(Atlassian cloud id ${ref})` : "(find the cloud id with getAccessibleAtlassianResources)";
}
```

In `packages/sandbox-core/sandbox.ts`:

1. L40: `import { jiraBrowseUrl } from "./issue_tracker.js";` → `import { jiraBrowseUrl, jiraSitePhrase } from "./issue_tracker.js";`
2. Delete these two lines (~L446-447):
   ```ts
   /** <org> Atlassian Cloud id — the site behind the Jira links in CLAUDE.md. */
   const JIRA_CLOUD_ID = "<old-cloud-id>";
   ```
3. ~L652, replace
   ```ts
       `1. Fetch Jira issue ${key} INCLUDING ITS COMMENTS using getJiraIssue (Atlassian cloud ` +
       `id ${JIRA_CLOUD_ID}) — request the \`comment\` field (e.g. ` +
   ```
   with
   ```ts
       `1. Fetch Jira issue ${key} INCLUDING ITS COMMENTS using getJiraIssue ${jiraSitePhrase()} ` +
       `— request the \`comment\` field (e.g. ` +
   ```
4. ~L683, replace
   ```ts
       `1. Fetch Jira issue ${key} INCLUDING ITS COMMENTS using getJiraIssue (Atlassian cloud ` +
       `id ${JIRA_CLOUD_ID}) — request fields: ["summary","description","comment"]. Comments often ` +
   ```
   with
   ```ts
       `1. Fetch Jira issue ${key} INCLUDING ITS COMMENTS using getJiraIssue ${jiraSitePhrase()} ` +
       `— request fields: ["summary","description","comment"]. Comments often ` +
   ```
5. ~L716: `searchJiraIssuesUsingJql (Atlassian cloud id ${JIRA_CLOUD_ID}) with jql ` → `searchJiraIssuesUsingJql ${jiraSitePhrase()} with jql `
6. ~L1860: `using getJiraIssue (Atlassian cloud id ${JIRA_CLOUD_ID}) — ` → `using getJiraIssue ${jiraSitePhrase()} — `

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run build -w sandbox-core && (cd packages/sandbox-core && node --test jira-site-ref.test.mjs issue-tracker.test.mjs) && git grep -n JIRA_CLOUD_ID -- packages`
Expected: all tests pass. The grep prints nothing. The build succeeding confirms the types.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/issue_tracker.ts packages/sandbox-core/sandbox.ts packages/sandbox-core/jira-site-ref.test.mjs
git commit -m "fix(sandbox-core): take the Jira site for MCP prompts from config, not a hardcoded cloud id"
```

---

### Task 2: Dashboard PR Jira link from config (A4)

**Files:**
- Modify: `packages/sandbox-core/sandbox.ts` (`OpenPr` interface ~L1582; `prFromView` stub ~L1688 and return ~L1695-1709)
- Modify: `apps/sandbox-dashboard/server.ts:643` (zod `openPrSchema`)
- Modify: `apps/sandbox-dashboard/src/prs-ui.ts` (PR type ~L30; link ~L278-282)
- Test: `apps/sandbox-dashboard/lib/open-prs.smoke.mjs`

**Interfaces:**
- Consumes: `jiraBrowseUrl(key: string): string | null` (existing, `issue_tracker.ts`).
- Produces: `OpenPr.jiraUrl: string | null`.

- [ ] **Step 1: Write the failing assertions** — in `apps/sandbox-dashboard/lib/open-prs.smoke.mjs`, add after the existing imports (before `const pkgRoot`):

```js
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const cfgFile = path.join(mkdtempSync(path.join(tmpdir(), "open-prs-")), "config.yaml");
writeFileSync(cfgFile, "jira:\n  base_url: https://example.atlassian.net/\n");
process.env.SANDBOX_CONFIG_FILE = cfgFile;
```

and after `assert.equal(pr.jiraKey, "PROJ-999", "jira key parsed from title");`:

```js
assert.equal(pr.jiraUrl, "https://example.atlassian.net/browse/PROJ-999", "jira url from jira.base_url");
writeFileSync(cfgFile, "paths: {}\n");
assert.equal(prFromView(view, "me").jiraUrl, null, "no jira.base_url → no link");
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run build -w sandbox-core && npm test -w sandbox-workspace-mcp-app`
Expected: FAIL at `jira url from jira.base_url` (actual `undefined`).

- [ ] **Step 3: Implement**

`packages/sandbox-core/sandbox.ts`, `OpenPr` interface: after `jiraKey: string | null;` add `jiraUrl: string | null;`.

In the unavailable stub of `prFromView` (~L1688), after `jiraKey: null,` add `jiraUrl: null,`.

In the main return of `prFromView`, compute the key once:

```ts
  const labels = (v.labels ?? []).map((l) => l.name ?? "").filter(Boolean);
  const title = v.title ?? "";
  const body = v.body ?? "";
  const jiraKey = parseJiraKey(`${title} ${body} ${v.headRefName ?? ""}`);
  return {
    ...
    jiraKey,
    jiraUrl: jiraKey ? jiraBrowseUrl(jiraKey) : null,
    isDraft: v.isDraft ?? false,
  };
```

`apps/sandbox-dashboard/server.ts` `openPrSchema`: after `jiraKey: z.string().nullable(),` add `jiraUrl: z.string().nullable(),`.

`apps/sandbox-dashboard/src/prs-ui.ts`: in the PR type (~L30), after `jiraKey: string | null;` add `jiraUrl: string | null;`. Replace the Jira block (~L278-282):

```ts
    if (pr.jiraKey) {
      meta.appendChild(
        pr.jiraUrl
          ? headLink("jira-link", pr.jiraKey, pr.jiraUrl, `Open ${pr.jiraKey} in Jira`)
          : el("span", "jira-link", pr.jiraKey),
      );
    }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run build -w sandbox-core && npm test -w sandbox-workspace-mcp-app && npm run typecheck -w sandbox-workspace-mcp-app && git grep -n <org> -- apps/sandbox-dashboard`
Expected: smoke passes, typecheck is clean, and the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/sandbox.ts apps/sandbox-dashboard/server.ts apps/sandbox-dashboard/src/prs-ui.ts apps/sandbox-dashboard/lib/open-prs.smoke.mjs
git commit -m "fix(dashboard): build the PR Jira link from jira.base_url"
```

---

### Task 3: Setup snippet placeholder and Jira test fixtures (A5, B3)

**Files:**
- Modify: `packages/sandbox-core/machine_setup.ts:766-773`
- Test: `apps/cli/src/lib/__tests__/jira_config.test.ts`

**Interfaces:**
- Consumes: `JIRA_CONFIG_SNIPPET: string` and `syncJiraToken` (existing exports of `sandbox-core/machine_setup`).

- [ ] **Step 1: Write the failing test.** In `jira_config.test.ts`:

- Change the import to `import { JIRA_CONFIG_SNIPPET, syncJiraToken } from "sandbox-core/machine_setup";`
- Change `FILLED` to:
  ```ts
  const FILLED = {
    base_url: "https://example.atlassian.net/",
    email: "dev@example.com",
    api_token: "real-token",
  };
  ```
- Add inside `describe("syncJiraToken", …)`:
  ```ts
  it("the unedited setup snippet counts as not configured", async () => {
    const snippet = YAML.parse(JIRA_CONFIG_SNIPPET).jira;
    const verified = () => [true, "verified"] as [boolean, string]; // never hit the network
    const step = await stepFor({ ...snippet, email: "dev@example.com", api_token: "real-token" }, verified);
    expect(step.ok).toBe(true);
    expect(step.detail).toContain("jira.base_url");
  });
  ```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run build -w sandbox-core && (cd apps/cli && npx vitest run src/lib/__tests__/jira_config.test.ts)`
Expected: the new test FAILS, because the <org> URL is accepted as filled and the verifier runs.

- [ ] **Step 3: Implement.** In `machine_setup.ts`:

```ts
const JIRA_PLACEHOLDERS = new Set([
  "PASTE_TOKEN_HERE",
  "<your-atlassian-login-email>",
  "https://your-org.atlassian.net",
]);

/** Copy-pasteable stanza for the report when the section is missing. */
export const JIRA_CONFIG_SNIPPET =
  "jira:\n" +
  "  base_url: https://your-org.atlassian.net\n" +
  "  email: <your-atlassian-login-email>\n" +
  "  api_token: PASTE_TOKEN_HERE";
```

- [ ] **Step 4: Run tests**

Run: `npm run build -w sandbox-core && (cd apps/cli && npx vitest run src/lib/__tests__/jira_config.test.ts)`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/machine_setup.ts apps/cli/src/lib/__tests__/jira_config.test.ts
git commit -m "fix(setup): neutral Jira placeholder in the setup snippet; generic test fixtures"
```

---

### Task 4: Slack review channel required (no default)

**Files:**
- Modify: `packages/sandbox-core/sandbox.ts` (~L1539-1557, `DEFAULT_REVIEW_SLACK_CHANNEL` and `postSlackReviewRequest`)
- Test: `packages/sandbox-core/review-slack.test.mjs` (create)

**Interfaces:**
- Produces: `postSlackReviewRequest(text: string): Promise<string>` (same signature). `DEFAULT_REVIEW_SLACK_CHANNEL` is removed, and nothing else imports it.

- [ ] **Step 1: Write the failing test** — create `packages/sandbox-core/review-slack.test.mjs`:

```js
// "Request review" posts to Slack only when both the token and the channel are set.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SANDBOX_REVIEW_SLACK_TOKEN = "xoxb-test";
delete process.env.SANDBOX_REVIEW_SLACK_CHANNEL;
globalThis.fetch = async () => {
  throw new Error("fetch must not be called");
};
const { postSlackReviewRequest } = await import("./dist/sandbox.js");

test("no channel configured → a clear error before any request", async () => {
  await assert.rejects(postSlackReviewRequest("please review"), /SANDBOX_REVIEW_SLACK_CHANNEL/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run build -w sandbox-core && (cd packages/sandbox-core && node --test review-slack.test.mjs)`
Expected: FAIL. The error is `Slack request failed: fetch must not be called`, because the default channel let it reach fetch.

- [ ] **Step 3: Implement.** In `sandbox.ts`, delete `export const DEFAULT_REVIEW_SLACK_CHANNEL = "<old-channel-id>";` and replace the doc comment and the head of `postSlackReviewRequest` through the `const channel` line with:

```ts
/**
 * Post a "please review this PR" message to Slack via chat.postMessage.
 * Requires SANDBOX_REVIEW_SLACK_TOKEN (a bot token with chat:write) and
 * SANDBOX_REVIEW_SLACK_CHANNEL. Either missing → a clear error, never a fake
 * success — the button must not claim it messaged Slack when it didn't.
 * Returns the channel it posted to.
 */
export async function postSlackReviewRequest(text: string): Promise<string> {
  const token = process.env.SANDBOX_REVIEW_SLACK_TOKEN;
  const channel = process.env.SANDBOX_REVIEW_SLACK_CHANNEL;
  if (!token || !channel) {
    throw new WorkspaceError(
      "Slack is not configured: set SANDBOX_REVIEW_SLACK_TOKEN (a bot token with chat:write) " +
        "and SANDBOX_REVIEW_SLACK_CHANNEL (the review channel id).",
    );
  }
```

The rest of the function (the `fetch` onward) stays unchanged.

- [ ] **Step 4: Run tests**

Run: `npm run build -w sandbox-core && (cd packages/sandbox-core && node --test review-slack.test.mjs) && npm run typecheck -w sandbox-workspace-mcp-app && git grep -n '<old-channel-id>\|DEFAULT_REVIEW_SLACK' -- packages apps`
Expected: test passes, the dashboard typecheck is clean, and the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/sandbox.ts packages/sandbox-core/review-slack.test.mjs
git commit -m "fix(sandbox-core): require SANDBOX_REVIEW_SLACK_CHANNEL instead of a hardcoded channel"
```

---

### Task 5: Supergraph config only when a subgraph exists (C4)

**Files:**
- Modify: `packages/sandbox-core/generate.ts` (doc comment ~L1076, `generateSupergraphConfig` ~L1081-1093)
- Test: `apps/cli/src/lib/__tests__/generate.test.ts:394-411`, `apps/cli/src/lib/__tests__/generate_workspace_compose.test.ts:44`

**Interfaces:**
- Produces: `generateSupergraphConfig(...): string | null`, which is null when the registry has no `_GRAPHQL_TYPES` service. Callers (`lifecycle.ts` L157, L469; `generate.ts` L1542) ignore the return and need no change.

- [ ] **Step 1: Write the failing tests.** In `generate.test.ts`, replace the whole `describe("generateSupergraphConfig", …)` block with:

```ts
describe("generateSupergraphConfig", () => {
  // Federation is opt-in: the demo registry has no graphql-subgraph service,
  // so nothing is written and a stale file from an earlier run is removed.
  it("writes nothing when no service is a GraphQL subgraph", () => {
    const stale = path.join(tmp, ".sandbox", "supergraph-config.yml");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "subgraphs: {}\n");
    expect(generateSupergraphConfig("myfeat", 1, [], null, tmp)).toBeNull();
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("writes the config when a service is a GraphQL subgraph", () => {
    const config = { services: { orders: { type: "graphql-subgraph", internal_port: 4000 } } };
    const outPath = generateSupergraphConfig("myfeat", 1, ["orders"], config, tmp);
    expect(outPath).toBe(path.join(tmp, ".sandbox", "supergraph-config.yml"));
    expect(fs.readFileSync(outPath!, "utf8")).toContain("http://orders:4000/graphql");
  });
});
```

In `generate_workspace_compose.test.ts`, replace line 44 with:

```ts
    // The fixture registry has no GraphQL subgraph, so no supergraph config.
    expect(fs.existsSync(path.join(tmp, ".sandbox", "supergraph-config.yml"))).toBe(false);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run build -w sandbox-core && (cd apps/cli && npx vitest run src/lib/__tests__/generate.test.ts src/lib/__tests__/generate_workspace_compose.test.ts)`
Expected: "writes nothing…" and the workspace-compose test FAIL, because a file is written. "writes the config…" passes.

- [ ] **Step 3: Implement.** In `generateSupergraphConfig`, change the return type to `string | null` and insert right after `const outPath = path.join(sandboxDir, "supergraph-config.yml");`:

```ts
  // Federation is opt-in: no graphql-type service in the registry → no file
  // (and drop one left by an earlier run).
  const hasSubgraph = Object.values(servicesConfig).some(
    (d) => isDict(d) && _GRAPHQL_TYPES.has(d["type"] ?? ""),
  );
  if (!hasSubgraph) {
    fs.rmSync(outPath, { force: true });
    return null;
  }
```

Add this line to the function's doc comment (~L1076): ` * Returns null and writes nothing when no service has a GraphQL type.`

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run build -w sandbox-core && (cd apps/cli && npx vitest run src/lib/__tests__/generate.test.ts src/lib/__tests__/generate_workspace_compose.test.ts) && npm run typecheck`
Expected: all pass, and the typecheck is clean across the workspace.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/generate.ts apps/cli/src/lib/__tests__/generate.test.ts apps/cli/src/lib/__tests__/generate_workspace_compose.test.ts
git commit -m "fix(generate): only write supergraph-config.yml when the registry has a GraphQL subgraph"
```

---

### Task 6: Identifiers in docs and fixtures (B1, B2, B4, B5, B6, D1)

**Files:**
- Modify: `docs/jira-rest-setup.md:20-22, 34, 41-44`
- Modify: `docs/troubleshooting-advanced.md:218-223`
- Modify: `apps/cli/src/lib/__tests__/setup_steps.test.ts` (`resolveSecrets` block)
- Modify: `packages/vscode-plugin/src/build-tree.test.mjs:91-97`
- Modify: `docs/known-issues.md:311`

- [ ] **Step 1: Edit `docs/jira-rest-setup.md`**

- Replace
  ```
       (log in with your Atlassian account — the one you use for
       <org>.atlassian.net).
  ```
  with
  ```
       (log in with your Atlassian account — the one you use for
       your Jira site, e.g. your-org.atlassian.net).
  ```
- `   JIRA_BASE_URL=https://<org>.atlassian.net` → `   JIRA_BASE_URL=https://your-org.atlassian.net`
- Replace
  ```
     `JIRA_EMAIL` is the address on your Atlassian *account*. Aliases appear to
     work (<personal-email> authenticated even though the account
     reports <personal-email>), but use the canonical one if in doubt —
     check your avatar menu in Jira.
  ```
  with
  ```
     `JIRA_EMAIL` is the address on your Atlassian *account*. Email aliases may
     authenticate too, but use the canonical one if in doubt — check your
     avatar menu in Jira.
  ```

- [ ] **Step 2: Edit `docs/troubleshooting-advanced.md`.** Delete this block, which is wrong because demo-services has no Auth0. Leave one blank line before `### GraphQL gateway`:

  ````
  ### backend (demo-services/apps/backend)

  **Auth0 errors:** Check that Auth0 secrets are set in `~/.sandbox/secrets.env`:
  ```bash
  grep -c "AUTH0" ~/.sandbox/secrets.env
  ```

  ````

- [ ] **Step 3: Rename fixtures**

```bash
perl -pi -e 's/auth-web/web-app/g; s/AUTH_WEB__/WEB_APP__/g; s/AUTH0_CLIENT_SECRET/OAUTH_CLIENT_SECRET/g; s/NEXTAUTH_SECRET/SESSION_SECRET/g' apps/cli/src/lib/__tests__/setup_steps.test.ts
perl -pi -e 's/TRE-<n>/PROJ-1125/g' packages/vscode-plugin/src/build-tree.test.mjs
```

- [ ] **Step 4: Edit `docs/known-issues.md:311`:** `` `/Users/<user>/repos/sandbox/apps/cli`). `` → `` `<sandbox-checkout>/apps/cli`). ``

- [ ] **Step 5: Run the affected tests**

Run: `(cd apps/cli && npx vitest run src/lib/__tests__/setup_steps.test.ts) && npm test -w vscode-plugin && git grep -nE '<org>|<org>|AUTH0|TRE-<n>|/Users/<user>' -- docs/jira-rest-setup.md docs/troubleshooting-advanced.md docs/known-issues.md apps/cli/src/lib/__tests__/setup_steps.test.ts packages/vscode-plugin/src`
Expected: tests pass, and the grep prints nothing.

- [ ] **Step 6: Commit**

```bash
git add docs/jira-rest-setup.md docs/troubleshooting-advanced.md docs/known-issues.md apps/cli/src/lib/__tests__/setup_steps.test.ts packages/vscode-plugin/src/build-tree.test.mjs
git commit -m "docs,test: replace org-specific hosts, emails, keys and paths with placeholders"
```

---

### Task 7: Delete the experiments and generalize the standards taxonomy (C1, C2, C3, B7)

**Files:**
- Delete: `docs/experiments/context-management/` (20 files)
- Modify: `docs/jit-context-system.md:33-34, 66-78, 480`
- Modify: `docs/context-management-research.md:226-228, 388-407`
- Modify: `docs/scamper-market-expansion.md:26-27`
- Modify: `docs/ponytail-debt.md:17-18`
- Modify: `packages/sandbox-core/skill_gen.ts:211`
- Modify: `docs/superpowers/specs/2026-09-27-context-strategy-interface.md:155`

- [ ] **Step 1: Delete the experiments**

```bash
git rm -r -q docs/experiments/context-management
rmdir docs/experiments 2>/dev/null || true
```

- [ ] **Step 2: Fix inbound references**

`docs/jit-context-system.md`:
- Replace
  ```
  Governing principles (each anchored to a measurement in
  [experiments/context-management/results/](experiments/context-management/results/)):
  ```
  with `Governing principles (each anchored to an internal measurement; the harnesses are not published):`
- Replace `Details in [experiments/context-management/results/](experiments/context-management/results/).` with `The harnesses and raw results are not published.`

`docs/context-management-research.md`: replace
```
Threads #1 and #2 have now been measured — see
[experiments/context-management/](experiments/context-management/) and its
[RESULTS.md](experiments/context-management/results/RESULTS.md). Findings below; the rest
remain open.
```
with
```
Threads #1 and #2 have now been measured in internal experiments (harnesses not
published). Findings below; the rest remain open.
```

`docs/scamper-market-expansion.md`: `` (`docs/experiments/context-management/`, harnesses 1–9) `` → `(harnesses 1–9, kept outside this repo)`

`docs/ponytail-debt.md`: replace
```
every one of them. The bare grep also picks up ~5 prose mentions in `docs/experiments/`
and `docs/jit-context-system.md` that are *about* the convention rather than markers;
```
with
```
every one of them. The bare grep also picks up a few prose mentions in
`docs/jit-context-system.md` that are *about* the convention rather than markers;
```

`packages/sandbox-core/skill_gen.ts:211`: ` * Measured (docs/experiments/context-management/results/): description length` → ` * Measured (internal context-management experiments): description length`

`docs/superpowers/specs/2026-09-27-context-strategy-interface.md:155`: `` Harness cell (`docs/experiments/context-management`): `` → `Harness cell (internal experiment harness, not in this repo):`

- [ ] **Step 3: C1, `docs/jit-context-system.md`.** Replace from `All nine current domains use directory form:` through the table's last row (`` | `ui` | … | ``) with:

```markdown
Domains come from the configured standards repo; the loader resolves none when it is
unset. An example set, in directory form:

| Domain | Covers |
|--------|--------|
| `comments` | Universal "comments explain the why, not the what" rubric |
| `engineering` | Cross-cutting constraints — architectural fit, reversible change, performance budgets, reviewable PRs |
| `service` | Service-boundary contracts — API conventions, contract evolution, cross-service resilience |
| `config` | Inter-service URL/DNS conventions and env-var rules |
| `auth` | Token audiences and scopes, session cookie scope |
| `testing` | Unit vs integration vs contract tests; what to mock at a service seam |
| `observability` | Tracing and structured-logging conventions, correlation-ID propagation |
| `data` | Pipeline ordering and scheduling, timestamp conventions |
| `ui` | Render/effect ordering, hydration, caching |
```

- [ ] **Step 4: C2, `docs/context-management-research.md`.**
- `` Generalize the planned `standards: [ui, graphql]` field `` → `` Generalize the planned `standards: [ui, service]` field ``
- Replace the YAML example body (the lines from `frontend:      { archetype: nextjs-ui }` through `test:         "npm run test:contract"`), keeping the fence and indentation, with:
  ```yaml
  frontend:   { archetype: web-ui }
  backend:    { archetype: api-service }

  archetypes:
    api-service:
      standards:    [service]                         # existing axis (§5.1/§5.5)
      mcp_servers:  [context7]                        # tool axis — which servers connect (#8)
      agent_tools:  [Read, Edit, Bash, "mcp__context7__*"]  # subagent tools:  frontmatter (#9)
      reference:    [api-conventions.md]
      run:          "npm run dev"
      test:         "npm run test:contract"
  ```
- Replace
  ```
      taxonomy: `nextjs-ui`, `graphql-subgraph`, `nest-api`, `data` (airflow),
      `mcp-server`.
  ```
  with
  ```
      taxonomy: `web-ui`, `api-service`, `data-pipeline`, `gateway`, `mcp-server`.
  ```

- [ ] **Step 5: Verify**

Run: `git grep -n 'experiments/' -- ':!docs/superpowers/archive'; git grep -nE 'Auth0|Airflow|airflow|nextjs-ui|nest-api|<private-service>' -- docs/jit-context-system.md docs/context-management-research.md; npm run build -w sandbox-core`
Expected: both greps print nothing, and the build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A docs/experiments docs/jit-context-system.md docs/context-management-research.md docs/scamper-market-expansion.md docs/ponytail-debt.md packages/sandbox-core/skill_gen.ts docs/superpowers/specs/2026-09-27-context-strategy-interface.md
git commit -m "docs: drop private-codebase experiments; generic standards domains and archetypes"
```

---

### Task 8: Present integrations as optional (C5, C6, C7, C8)

**Files:**
- Modify: `docs/users-guide.md` (TOC ~L41-45; L261, L370, L1209, L1233-1235, L1656, L1678; new subsection before `## Generated Files`)
- Modify: `docs/sandbox-architecture.md:292-296, 406, 421, 456, 476`
- Modify: `apps/cli/infra/skills/sb-pr/SKILL.md:17-38`

- [ ] **Step 1: `docs/users-guide.md`, the new subsection.** Insert immediately before `## Generated Files`:

```markdown
### Optional integrations

None of these are required; each turns on only when configured.

#### Issue tracker

`sandbox setup` asks which tracker this machine uses — `jira` (the default) or `github` —
and stores it as `overrides.issue_tracker` in `~/.sandbox/config.yaml`. With `github`, a
workspace's ticket is `owner/repo#n` and issues are filed in the registry repos under
`overrides.github_org`.

For Jira, set `jira.base_url` (e.g. `https://your-org.atlassian.net`) to get ticket links in
CLAUDE.md, the dashboard, and VS Code. Briefings fetched through the Atlassian MCP use
`jira.cloud_id` when set, otherwise the `base_url` hostname. The REST token is optional; see
[jira-rest-setup.md](jira-rest-setup.md).

#### Slack review requests

The dashboard's "Request review" button posts to Slack. Set both
`SANDBOX_REVIEW_SLACK_TOKEN` (a bot token with `chat:write`) and
`SANDBOX_REVIEW_SLACK_CHANNEL` (the channel id). Without them the button reports that Slack
is not configured.

#### GraphQL federation

When a service in the registry has `type: graphql-subgraph`, `sandbox up` writes
`<workspace>/.sandbox/supergraph-config.yml` listing each subgraph's URL for your gateway.
Registries without a subgraph get no file.

```

Add to the TOC as the last sub-entry under `9. [Configuration Files]` (just before `10. [Generated Files]`), matching the sibling indentation: `   - [Optional integrations](#optional-integrations)`

- [ ] **Step 2: `docs/users-guide.md`, the supergraph mentions**
- L261: `` and `supergraph-config.yml` to `<workspace>/.sandbox/` `` → `` and, when the registry has a GraphQL subgraph, `supergraph-config.yml` to `<workspace>/.sandbox/` ``
- L370: `` `<workspace>/.sandbox/supergraph-config.yml` — Apollo Federation config `` → `` `<workspace>/.sandbox/supergraph-config.yml` — GraphQL federation config (only when a service has `type: graphql-subgraph`) ``
- L1209: replace the sentence with ``When you run `sandbox up <feature>`, `docker-compose.yml` and `.env` are generated at the feature's workspace root, plus `supergraph-config.yml` under `<workspace>/.sandbox/` when the registry has a GraphQL subgraph:``
- L1235: replace with ``Optional — generated only when a service has `type: graphql-subgraph`. Lists each subgraph with its URL for an Apollo-compatible gateway — local services point to slot ports, remote services point to k8s forwards.``
- L1656: `← Apollo Federation routing` → `← GraphQL federation routing (optional)`
- L1678: `│       └── .sandbox/supergraph-config.yml` → `│       └── .sandbox/supergraph-config.yml  (if a GraphQL subgraph exists)`

- [ ] **Step 3: `docs/sandbox-architecture.md`**
- L292: `### 6. Apollo Federation Gateway Configuration` → `### 6. GraphQL Federation (optional)`, and insert as the first paragraph under it: ``Applies only when the registry has a service with a GraphQL type (`graphql-subgraph`, `graphql`, `subgraph`, `federation`). Without one, no supergraph config is generated.``
- L406: `# Template for Apollo gateway` → `# Template for the optional GraphQL gateway`
- L421: `# Generated Apollo gateway config` → `# Generated only when a GraphQL subgraph exists`
- L456: `Render supergraph-config.yml (if any graphql subgraph is local)` → `Render supergraph-config.yml (only if the registry has a GraphQL subgraph)`
- L476: `"  k8s:    graphql-gateway (:9004), redis (:9050), ..."` → `"  k8s:    api (:9004), redis (:9050), ..."`

- [ ] **Step 4: `apps/cli/infra/skills/sb-pr/SKILL.md`**
- `` - **Title:** `<type>(<optional scope>): <JIRA-ID> <short description>` — `` → `` - **Title:** `<type>(<optional scope>): <ISSUE-ID> <short description>` — ``
- After the line `` Example: `feat(backend): PROJ-1125 Add rating field to the product payload` `` add, at the same indentation:
  ```
       `<ISSUE-ID>` is the workspace's ticket: a Jira key (`PROJ-1125`) or a GitHub
       issue (`acme/backend#42`). No ticket → omit it.
  ```
- `     Refs: <JIRA-ID>` → `     Refs: <ISSUE-ID>`
- Replace
  ```
     - **Jira:** transition the ticket named in the title to **In Development**
       (use your configured Jira tooling; connection specifics live in your
       personal config, not this skill).
  ```
  with
  ```
     - **Jira only:** when the ticket is a Jira key, transition it to **In
       Development** (use your configured Jira tooling; connection specifics
       live in your personal config, not this skill). Skip for GitHub issues.
  ```

- [ ] **Step 5: Verify**

Run: `git grep -n 'Apollo Federation\|graphql-gateway (:9004)\|JIRA-ID' -- docs/users-guide.md docs/sandbox-architecture.md apps/cli/infra/skills/sb-pr/SKILL.md; git grep -n 'optional-integrations\|### Optional integrations' docs/users-guide.md`
Expected: the first grep prints nothing. The second prints the TOC entry and the heading.

- [ ] **Step 6: Commit**

```bash
git add docs/users-guide.md docs/sandbox-architecture.md apps/cli/infra/skills/sb-pr/SKILL.md
git commit -m "docs: present Jira/GitHub, Slack and GraphQL federation as optional integrations"
```

---

### Task 9: Personal leakage in superpowers docs, archive, `.pyc` (D2-D5, side findings)

**Files:**
- Modify: `docs/superpowers/plans/2026-10-01-registry-fragments.md`, `docs/superpowers/plans/2026-10-02-sandbox-detect-fragment.md`, `docs/superpowers/specs/2026-10-01-registry-fragments-design.md`, `docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md`
- Delete: `docs/superpowers/archive/` (18 files)
- Untrack: 4 `.pyc` files
- Modify: `.gitignore`

- [ ] **Step 1: Scrub**

```bash
perl -pi -e 's#/Users/<user>/repos/#~/repos/#g; s#/Users/<user>#~#g; s/<personal-repo>/mobile-app/gi' \
  docs/superpowers/plans/2026-10-01-registry-fragments.md \
  docs/superpowers/plans/2026-10-02-sandbox-detect-fragment.md \
  docs/superpowers/specs/2026-10-01-registry-fragments-design.md \
  docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md
```

- [ ] **Step 2: Delete the archive and untrack bytecode**

```bash
git rm -r -q docs/superpowers/archive
git rm --cached -q bin/__pycache__/*.pyc plugins/sandbox-tools/skills/*/scripts/__pycache__/*.pyc
printf '\n# Python bytecode\n__pycache__/\n*.pyc\n' >> .gitignore
```

- [ ] **Step 3: Verify**

Run: `git grep -nE '/Users/<user>|<personal-repo>' -- docs/superpowers; git ls-files | grep -c '\.pyc$'; git status --short | grep pyc`
Expected: the grep prints nothing, the count is `0`, and the `.pyc` files don't appear as untracked because they're now ignored.

- [ ] **Step 4: Commit**

```bash
git add -A docs/superpowers .gitignore bin plugins
git commit -m "chore: scrub personal paths from plans/specs, drop archive and committed bytecode"
```

---

### Task 10: Final verification

- [ ] **Step 1: Leak grep across the tree**

Run:
```bash
git grep -nE 'hg[d]ata|hginsight[s]|4a4bd2[0]b|C0963TE8J9[1]|/Users/jay[b]oyer|interview-servic[e]|wellnes[s]|TRE-112[5]' -- ':!*.bundle.js'
git grep -n 'experiments/context-management' -- ':!docs/superpowers/*/2026-10-04-external-references-cleanup*'
```
Expected: both print nothing.

- [ ] **Step 2: Full CI gate**

Run: `npm run build && npm run typecheck && npm test`
Expected: all three succeed. If anything fails, fix it in the task that owns the file and amend with a new commit, not `--amend`.

- [ ] **Step 3: Report**

List the commits (`git log --oneline main..`). Tell the user `external-references-review.md` is still untracked and can be deleted.
