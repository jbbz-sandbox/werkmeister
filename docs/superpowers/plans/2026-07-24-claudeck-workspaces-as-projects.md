# Feature Workspaces as Claudeck Projects (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An on-demand script (`npm run claudeck:sync`) that idempotently registers every sandbox feature workspace as a claudeck project in `repos.json`, so chat opens rooted at each workspace's root.

**Architecture:** A pure merge function (`scripts/lib/merge-workspaces.mjs`) computes the new `repos.json` object from the existing one plus the workspace list; a thin IO wrapper (`scripts/sync-workspaces-to-claudeck.mjs`) reads `listWorkspaces()` from `sandbox-driver`, resolves the claudeck config path, and writes the file. Managed entries are marked by an `r_ws_` id prefix so re-syncs update/prune them while leaving manual entries alone.

**Tech Stack:** Node ≥18 ESM, `node:test`, `sandbox-driver` (workspace package).

## Global Constraints

- Managed group: `{ id: "g_sandbox_workspaces", name: "Feature Workspaces", parentId: null }`.
- Managed repo id format: `r_ws_<workspace-name>`. The `r_ws_` prefix is the sole managed marker.
- Preserve all non-managed repos and all groups untouched. Merge must be idempotent.
- Dedupe: never emit a managed repo whose `path` is already held by a non-managed entry (object `path` OR bare-string entry).
- Config path: `(process.env.CLAUDECK_HOME || ~/.claudeck)/config/repos.json`.
- Output format: `JSON.stringify(data, null, 2) + "\n"` (matches the repos plugin's `writeData`).
- Prerequisite: `packages/sandbox-driver` must be built (`dist/`) so `listWorkspaces` is importable.

---

### Task 1: Pure merge function + unit test

**Files:**
- Create: `scripts/lib/merge-workspaces.mjs`
- Test: `scripts/lib/merge-workspaces.test.mjs`

**Interfaces:**
- Produces: `mergeWorkspaces(existing, workspaces) -> { groups, repos, ... }` where `existing` is a parsed `repos.json` (`{groups:[], repos:[]}`) and `workspaces` is `listWorkspaces().workspaces` (`[{name, path, jiraUrl, ...}]`).

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/merge-workspaces.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWorkspaces } from "./merge-workspaces.mjs";

const existing = {
  groups: [{ id: "g_manual", name: "Manual", parentId: null }],
  repos: [
    { id: "r_manual1", name: "manual-one", path: "/x/manual-one", groupId: "g_manual", url: null },
    { id: "r_ws_gone", name: "gone", path: "/ws/gone", groupId: "g_sandbox_workspaces", url: null },
  ],
};
const workspaces = [
  { name: "test-me", path: "/ws/test-me", jiraUrl: "https://j/TRE-1" },
  { name: "claudeck-test", path: "/ws/claudeck-test", jiraUrl: null },
];

test("adds managed group and workspace repos", () => {
  const out = mergeWorkspaces(existing, workspaces);
  assert.ok(out.groups.some((g) => g.id === "g_sandbox_workspaces" && g.name === "Feature Workspaces"));
  const tm = out.repos.find((r) => r.id === "r_ws_test-me");
  assert.deepEqual(tm, { id: "r_ws_test-me", name: "test-me", path: "/ws/test-me", groupId: "g_sandbox_workspaces", url: "https://j/TRE-1" });
  assert.ok(out.repos.some((r) => r.id === "r_ws_claudeck-test" && r.url === null));
});

test("preserves manual entries and prunes stale managed", () => {
  const out = mergeWorkspaces(existing, workspaces);
  assert.ok(out.groups.some((g) => g.id === "g_manual"));
  assert.ok(out.repos.some((r) => r.id === "r_manual1"));
  assert.ok(!out.repos.some((r) => r.id === "r_ws_gone"));
});

test("is idempotent", () => {
  const once = mergeWorkspaces(existing, workspaces);
  const twice = mergeWorkspaces(once, workspaces);
  assert.deepEqual(twice, once);
});

test("dedupes against a manual entry holding a workspace path", () => {
  const withManualDup = {
    groups: [],
    repos: [{ id: "r_manual2", name: "tm-manual", path: "/ws/test-me", groupId: null, url: null }],
  };
  const out = mergeWorkspaces(withManualDup, workspaces);
  assert.ok(!out.repos.some((r) => r.id === "r_ws_test-me")); // skipped: path already manual
  assert.ok(out.repos.some((r) => r.id === "r_ws_claudeck-test"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/lib/merge-workspaces.test.mjs`
Expected: FAIL — cannot find module `./merge-workspaces.mjs` (not created yet).

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/merge-workspaces.mjs`:
```js
// Pure: compute a new claudeck repos.json object from the existing one plus the
// current sandbox workspace list. No IO. Managed entries carry an `r_ws_` id
// prefix; everything else is preserved untouched. See the Phase 2 spec.

const GROUP_ID = "g_sandbox_workspaces";
const GROUP_NAME = "Feature Workspaces";
const MANAGED_PREFIX = "r_ws_";

const isManaged = (r) =>
  r && typeof r === "object" && typeof r.id === "string" && r.id.startsWith(MANAGED_PREFIX);

// Path claimed by a non-managed entry: object `.path` or a bare-string entry.
const entryPath = (r) => (typeof r === "string" ? r : r && r.path) || null;

export function mergeWorkspaces(existing, workspaces) {
  const groups = Array.isArray(existing?.groups) ? [...existing.groups] : [];
  const repos = Array.isArray(existing?.repos) ? [...existing.repos] : [];

  if (!groups.some((g) => g && g.id === GROUP_ID)) {
    groups.push({ id: GROUP_ID, name: GROUP_NAME, parentId: null });
  }

  const nonManaged = repos.filter((r) => !isManaged(r));
  const manualPaths = new Set(nonManaged.map(entryPath).filter(Boolean));

  const managed = [];
  for (const ws of workspaces || []) {
    if (!ws || !ws.name || !ws.path) continue;
    if (manualPaths.has(ws.path)) continue; // a manual entry already covers this path
    managed.push({
      id: `${MANAGED_PREFIX}${ws.name}`, // workspace names are unique lowercase-hyphen slugs
      name: ws.name,
      path: ws.path,
      groupId: GROUP_ID,
      url: ws.jiraUrl || null,
    });
  }

  return { ...existing, groups, repos: [...nonManaged, ...managed] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/lib/merge-workspaces.test.mjs`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd /Users/jayboyer/workspace/sandbox
git add scripts/lib/merge-workspaces.mjs scripts/lib/merge-workspaces.test.mjs
git commit -m "feat(claudeck): pure mergeWorkspaces for repos.json sync + tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: IO wrapper, npm script, and live sync

**Files:**
- Create: `scripts/sync-workspaces-to-claudeck.mjs`
- Modify: `package.json` (root) — add the `claudeck:sync` script

**Interfaces:**
- Consumes: `mergeWorkspaces` from Task 1; `listWorkspaces` from `sandbox-driver`.
- Produces: writes `(CLAUDECK_HOME||~/.claudeck)/config/repos.json`; CLI prints a one-line summary.

- [ ] **Step 1: Ensure the driver is built (prerequisite)**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox
npm run build --workspace=packages/sandbox-driver 2>/dev/null || (cd packages/sandbox-driver && npm run build)
node -e "import('sandbox-driver').then(m => console.log(typeof m.listWorkspaces === 'function' ? 'listWorkspaces OK' : 'MISSING'))"
```
Expected: prints `listWorkspaces OK`.

- [ ] **Step 2: Write the IO wrapper**

Create `scripts/sync-workspaces-to-claudeck.mjs`:
```js
#!/usr/bin/env node
// On-demand sync: register every sandbox feature workspace as a claudeck
// project in repos.json. Idempotent + non-destructive (see Phase 2 spec).
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { listWorkspaces } from "sandbox-driver";
import { mergeWorkspaces } from "./lib/merge-workspaces.mjs";

const userDir = process.env.CLAUDECK_HOME || join(homedir(), ".claudeck");
const configDir = join(userDir, "config");
const reposFile = join(configDir, "repos.json");

async function readExisting() {
  try {
    return JSON.parse(await readFile(reposFile, "utf-8"));
  } catch {
    return { groups: [], repos: [] };
  }
}

export async function main() {
  const { workspaces } = await listWorkspaces();
  const existing = await readExisting();
  const next = mergeWorkspaces(existing, workspaces);
  await mkdir(configDir, { recursive: true });
  await writeFile(reposFile, JSON.stringify(next, null, 2) + "\n");
  const managed = next.repos.filter((r) => r?.id?.startsWith?.("r_ws_")).length;
  console.log(`Synced ${managed} workspace(s) -> ${reposFile}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Add the npm script**

In root `package.json`, add to `"scripts"`:
```json
    "claudeck:sync": "node scripts/sync-workspaces-to-claudeck.mjs",
```

- [ ] **Step 4: Back up the current repos.json, then run the sync**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox
cp ~/.claudeck/config/repos.json /tmp/repos.json.bak 2>/dev/null || true
npm run claudeck:sync
```
Expected: prints `Synced N workspace(s) -> …/repos.json` where N ≥ 1.

- [ ] **Step 5: Verify the written file — managed entries, group, valid JSON**

Run:
```bash
node -e "const d=require(require('os').homedir()+'/.claudeck/config/repos.json'); \
  console.log('group:', d.groups.some(g=>g.id==='g_sandbox_workspaces')); \
  console.log('managed:', d.repos.filter(r=>r?.id?.startsWith?.('r_ws_')).map(r=>r.id)); \
  console.log('paths absolute:', d.repos.filter(r=>r?.id?.startsWith?.('r_ws_')).every(r=>r.path.startsWith('/')));"
```
Expected: `group: true`; a non-empty `managed: [...]` list; `paths absolute: true`.

- [ ] **Step 6: Verify idempotence at the file level**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox
cp ~/.claudeck/config/repos.json /tmp/repos.after1.json
npm run claudeck:sync
diff /tmp/repos.after1.json ~/.claudeck/config/repos.json && echo "IDEMPOTENT OK"
```
Expected: no diff output, then `IDEMPOTENT OK`.

- [ ] **Step 7: Commit**

```bash
cd /Users/jayboyer/workspace/sandbox
git add scripts/sync-workspaces-to-claudeck.mjs package.json
git commit -m "feat(claudeck): claudeck:sync script — register sandbox workspaces as projects

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Manual UI acceptance (MANUAL)

Confirms the end goal in the running claudeck. Requires the Phase 1 server (or restart `cd apps/claudeck && node cli.js --port 9009 --no-auth`).

**Files:** none (verification only).

- [ ] **Step 1: Refresh and confirm the group appears**

Open `http://localhost:9009`, refresh. Expected: a **Feature Workspaces** group listing the sandbox workspaces (e.g. `test-me`, `claudeck-test`) as projects.

- [ ] **Step 2: Confirm chat roots at a synced workspace**

Select a workspace project and send: `Run pwd and show me the output.`
Expected: the response reports that workspace's absolute path (e.g. `/Users/jayboyer/workspace/features/test-me`).

- [ ] **Step 3: Record acceptance**

Append a short "Phase 2 acceptance" note (date, group appeared, chat rooted correctly) to `apps/claudeck/VENDORED.md` and commit:
```bash
cd /Users/jayboyer/workspace/sandbox
git add apps/claudeck/VENDORED.md
git commit -m "docs(claudeck): record Phase 2 acceptance (workspaces appear as projects)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**
- Standalone script + npm run → Task 2 (`scripts/sync-workspaces-to-claudeck.mjs`, `claudeck:sync`). ✓
- Source `listWorkspaces()` → Task 2 Step 2. ✓
- Target `configPath` honoring `CLAUDECK_HOME` → Task 2 wrapper (`userDir`). ✓
- Canonical schema `{id,name,path,groupId,url}` + managed group → Task 1 impl. ✓
- Idempotent, non-destructive, prune, dedupe (incl. bare-string paths) → Task 1 tests + impl; Task 2 Step 6. ✓
- Pure testable merge → Task 1 (split into `scripts/lib/merge-workspaces.mjs` so the unit test needs no `sandbox-driver` build — a refinement over the spec's single-file note, same intent). ✓
- Driver-built prerequisite → Task 2 Step 1. ✓
- No-restart / UI refresh + pwd rooting → Task 3. ✓

**Placeholder scan:** No TBD/TODO; all code is complete; Task 3 is explicitly manual. ✓

**Type consistency:** `mergeWorkspaces(existing, workspaces)` signature and the `r_ws_`/`g_sandbox_workspaces`/`Feature Workspaces` constants are identical across Task 1 impl, Task 1 tests, and Task 2 verification. ✓
