# Persistent Jira Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two claude-backed Jira caches (status pills + form briefing) persistent on disk, cross-process, per-key, and force-refreshable.

**Architecture:** A new `lib/cache.ts` module backs a single JSON file at `~/.sandbox/jira-cache.json` with atomic merge-writes and a stale-while-revalidate `withCache` wrapper (plus `cacheGet`/`cacheSet`/`runBatchOnce` primitives for the batched status path). `getJiraStatuses` and the briefing paths in `lib/sandbox.ts` are re-keyed per Jira key onto this module, retiring the two in-memory `Map`s. A `refresh` flag threads from a topbar ↻ control through the `jira-statuses` tool.

**Tech Stack:** TypeScript (Node ESM), `node:fs` promises, MCP SDK (`server.registerTool`), Zod input schemas, Vite-built browser bundle. Tests: plain Node + `node:assert` smoke scripts (matching `lib/session-stream.smoke.mjs`).

## Global Constraints

- No new dependencies (`package.json` unchanged).
- Cache file path: `~/.sandbox/jira-cache.json`, overridable via `SANDBOX_CACHE_FILE` env var (for tests). Resolve lazily from `os.homedir()` each call.
- Namespaced keys: `status:<KEY>` and `briefing:<KEY>` (KEY uppercased, e.g. `PROJ-1234`).
- TTLs unchanged: status `5 * 60 * 1000` ms, briefing `15 * 60 * 1000` ms.
- Atomic writes only: temp file + `fs.rename`; re-read-and-merge before writing so a concurrent writer's key survives.
- `undefined` from a fetcher = failure → not stored (retry next read). A stored value MAY be `null` (briefing "fetched-but-empty" — do not treat `null` as failure).
- Out of scope: `workspace-prs`, `workspace-status`, `gke-forwards-status`, `kube-context`. No live push of refreshed values into rendered pills.
- Build/verify with `npm run build` (runs `tsc --noEmit`, Vite UI build, and `tsc` server build) from `apps/mcp-workspace/`.

---

### Task 1: Persistent cache module + smoke test

**Files:**
- Create: `apps/mcp-workspace/lib/cache.ts`
- Test: `apps/mcp-workspace/lib/cache.smoke.mjs`

**Interfaces:**
- Produces:
  - `cacheGet<T>(key: string): Promise<{ v: T; at: number } | undefined>`
  - `cacheSet<T>(key: string, v: T): Promise<void>`
  - `runBatchOnce(keys: string[], job: (fresh: string[]) => Promise<void>): void`
  - `runOnce(key: string, job: () => Promise<void>): void`
  - `withCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T | undefined>, opts?: { refresh?: boolean }): Promise<T | undefined>`

- [ ] **Step 1: Write the smoke test**

Create `apps/mcp-workspace/lib/cache.smoke.mjs`:

```js
// Smoke test for lib/cache: persistence, TTL, stale-while-revalidate, atomic
// merge, refresh bypass, failure-is-not-stored.
//   npm run build && node lib/cache.smoke.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cache-"));
const cacheFile = path.join(tmp, "jira-cache.json");
process.env.SANDBOX_CACHE_FILE = cacheFile;

const { cacheGet, cacheSet, withCache, runBatchOnce } = await import(
  path.join(pkgRoot, "lib", "cache.js")
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. cold miss → fetcher runs, value stored + returned
let calls = 0;
let v = await withCache("status:A", 1000, async () => { calls++; return "up"; });
assert.equal(v, "up");
assert.equal(calls, 1);
assert.deepEqual((await cacheGet("status:A")).v, "up");

// 2. fresh hit → fetcher NOT called
v = await withCache("status:A", 1000, async () => { calls++; return "changed"; });
assert.equal(v, "up");
assert.equal(calls, 1);

// 3. persistence across "processes": a fresh readStore sees it on disk
assert.ok(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))["status:A"]);

// 4. stale → returns stale synchronously AND background-refreshes the store
await cacheSet("status:B", "old");
// force staleness by rewriting `at` into the past
const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
raw["status:B"].at = Date.now() - 10_000;
fs.writeFileSync(cacheFile, JSON.stringify(raw));
let bgCalls = 0;
v = await withCache("status:B", 1000, async () => { bgCalls++; return "new"; });
assert.equal(v, "old"); // served stale immediately
await sleep(50);
assert.equal(bgCalls, 1);
assert.equal((await cacheGet("status:B")).v, "new"); // background updated the store

// 5. refresh:true → bypass a fresh entry
v = await withCache("status:A", 1000, async () => "refreshed", { refresh: true });
assert.equal(v, "refreshed");
assert.equal((await cacheGet("status:A")).v, "refreshed");

// 6. failed fetch (undefined) → nothing stored, no throw
v = await withCache("status:C", 1000, async () => undefined);
assert.equal(v, undefined);
assert.equal(await cacheGet("status:C"), undefined);

// 7. stored null is a real value, not a failure
await cacheSet("briefing:X", null);
v = await withCache("briefing:X", 1000, async () => { throw new Error("should not fetch"); });
assert.equal(v, null);

// 8. concurrent merge → both keys survive
await Promise.all([cacheSet("status:D", "d"), cacheSet("status:E", "e")]);
const merged = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
assert.ok(merged["status:D"] && merged["status:E"]);

// 9. runBatchOnce dedupes in-flight keys
let batch = 0;
runBatchOnce(["k1", "k2"], async () => { batch++; await sleep(30); });
runBatchOnce(["k1"], async () => { batch++; await sleep(30); }); // k1 in-flight → skipped
await sleep(60);
assert.equal(batch, 1);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("cache.smoke: OK");
```

- [ ] **Step 2: Run the smoke test to verify it fails (module missing)**

Run: `cd apps/mcp-workspace && npm run build`
Expected: `tsc` build FAILS — `lib/cache.ts` does not exist / cannot resolve `./lib/cache.js` import in the smoke (or the smoke errors `Cannot find module`). This confirms the test targets code that isn't there yet.

- [ ] **Step 3: Write the cache module**

Create `apps/mcp-workspace/lib/cache.ts`:

```ts
/**
 * Persistent, cross-process TTL cache for the claude-backed Jira lookups
 * (status pills + form briefing). One JSON file at ~/.sandbox/jira-cache.json
 * holds namespaced `{ v, at }` entries, shared by the long-lived MCP server and
 * the short-lived browser-form CLI. Reads load the file on demand; writes
 * re-read-merge-and-atomically-rename so concurrent writers don't clobber each
 * other's keys.
 *
 * Staleness is stale-while-revalidate: a fresh entry is served as-is, a stale
 * entry is served immediately while a deduped background fetch updates the
 * store for the next read, and a cold miss blocks on the fetch.
 *
 * Writes are serialized within the process (a write chain) so concurrent
 * cacheSet calls don't lose each other's keys, then committed atomically
 * (unique tmp + rename).
 *
 * ponytail: whole-file read-modify-write; in-process writes are serialized, but
 * separate processes still race — last atomic rename wins (a torn interleaving
 * at worst re-fetches one key). Go SQLite only if entries reach the thousands.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CacheEntry<T> {
  v: T;
  at: number;
}

type Store = Record<string, { v: unknown; at: number }>;

function cacheFilePath(): string {
  return process.env.SANDBOX_CACHE_FILE || path.join(os.homedir(), ".sandbox", "jira-cache.json");
}

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFilePath(), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {}; // missing or corrupt → treat as empty, never throw to the caller
  }
}

// Shared across withCache and the batched status path so an expired read
// triggers at most one background claude -p per key.
const inFlight = new Set<string>();

/** Read one entry (undefined if absent). Does NOT apply TTL — callers decide. */
export async function cacheGet<T>(key: string): Promise<CacheEntry<T> | undefined> {
  const e = (await readStore())[key];
  return e ? { v: e.v as T, at: e.at } : undefined;
}

// In-process write serialization: each cacheSet appends to this chain so
// concurrent calls run their read-modify-write one at a time (each sees prior
// writes). `writeSeq` gives every temp file a unique name.
let writeChain: Promise<void> = Promise.resolve();
let writeSeq = 0;

/** Atomically merge one key into the store (serialized read-latest → set → tmp+rename). */
export function cacheSet<T>(key: string, v: T): Promise<void> {
  const run = writeChain.then(async () => {
    const file = cacheFilePath();
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const store = await readStore();
      store[key] = { v, at: Date.now() };
      const tmp = `${file}.${process.pid}.${++writeSeq}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(store), "utf-8");
      await fs.rename(tmp, file);
    } catch (e) {
      // Best-effort cache — a write miss only costs a future re-fetch.
      console.error(`[sandbox-workspace] cache write failed for ${key}:`, (e as Error).message);
    }
  });
  writeChain = run.catch(() => {});
  return run;
}

/**
 * Fire-and-forget `job` for the subset of `keys` not already being refreshed,
 * claiming them in the in-flight set for the job's duration.
 */
export function runBatchOnce(keys: string[], job: (fresh: string[]) => Promise<void>): void {
  const fresh = keys.filter((k) => !inFlight.has(k));
  if (!fresh.length) return;
  fresh.forEach((k) => inFlight.add(k));
  void Promise.resolve()
    .then(() => job(fresh))
    .catch(() => {})
    .finally(() => fresh.forEach((k) => inFlight.delete(k)));
}

/** Single-key convenience over runBatchOnce. */
export function runOnce(key: string, job: () => Promise<void>): void {
  runBatchOnce([key], () => job());
}

/**
 * Single-key stale-while-revalidate. `fetcher` returns the fresh value or
 * `undefined` on failure (not stored — retried next read). A stored value may
 * itself be `null` (a real "fetched-but-empty" entry), which is served as-is.
 */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T | undefined>,
  opts?: { refresh?: boolean },
): Promise<T | undefined> {
  if (opts?.refresh) {
    const v = await fetcher();
    if (v !== undefined) await cacheSet(key, v);
    return v;
  }
  const hit = await cacheGet<T>(key);
  if (hit) {
    if (Date.now() - hit.at >= ttlMs) {
      runOnce(key, async () => {
        const v = await fetcher();
        if (v !== undefined) await cacheSet(key, v);
      });
    }
    return hit.v; // fresh or stale → served immediately
  }
  const v = await fetcher(); // cold miss → block
  if (v !== undefined) await cacheSet(key, v);
  return v;
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `cd apps/mcp-workspace && npm run build && node lib/cache.smoke.mjs`
Expected: build succeeds; script prints `cache.smoke: OK` and exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-workspace/lib/cache.ts apps/mcp-workspace/lib/cache.smoke.mjs
git commit -m "feat(mcp-workspace): persistent cross-process TTL cache module"
```

---

### Task 2: Re-key getJiraStatuses per key + refresh flag

**Files:**
- Modify: `apps/mcp-workspace/lib/sandbox.ts` (`getJiraStatuses`, ~L636-670; remove `jiraStatusCache`)
- Modify: `apps/mcp-workspace/server.ts` (`jira-statuses` tool, ~L552-582)

**Interfaces:**
- Consumes (from Task 1): `cacheGet`, `cacheSet`, `runBatchOnce`.
- Produces:
  - `getJiraStatuses(keys: string[], opts?: { refresh?: boolean }): Promise<Record<string, string>>`
  - Internal `fetchJiraStatusBatch(keys: string[]): Promise<Record<string, string>>` (the claude -p call, uppercased result, `{}` on failure).

- [ ] **Step 1: Add the cache import**

At the top of `lib/sandbox.ts`, add to the imports (near the other local imports):

```ts
import { cacheGet, cacheSet, runBatchOnce } from "./cache.js";
```

- [ ] **Step 2: Replace the jiraStatusCache Map and getJiraStatuses body**

In `lib/sandbox.ts`, replace this block:

```ts
const jiraStatusCache = new Map<string, { statuses: Record<string, string>; at: number }>();
const JIRA_STATUS_TTL_MS = 5 * 60 * 1000;

export async function getJiraStatuses(keys: string[]): Promise<Record<string, string>> {
  const valid = [...new Set(keys.map((k) => parseJiraKey(k)).filter((k): k is string => !!k))].sort(
    (a, b) => a.localeCompare(b),
  );
  if (!valid.length) return {};
  const cacheKey = valid.join(",");
  const hit = jiraStatusCache.get(cacheKey);
  if (hit && Date.now() - hit.at < JIRA_STATUS_TTL_MS) return hit.statuses;

  const prompt =
    "You are a data extractor, not an agent. Do exactly two things and nothing else:\n" +
    `1. Run searchJiraIssuesUsingJql (Atlassian cloud id ${JIRA_CLOUD_ID}) with jql ` +
    `'key in (${valid.join(",")})' and fields ["status"].\n` +
    "2. Output ONLY a JSON object between <result> and </result> tags mapping each issue key " +
    'to its status name, e.g. {"PROJ-1234":"In Progress"}. Omit keys you could not fetch. ' +
    "Do not create, edit, transition, or comment on anything; write no prose outside the tags.\n" +
    "If the search fails entirely, output <result>{}</result> and nothing else.";
  try {
    const bin = await resolveClaudeBin();
    const res = await runCapture(bin, ["-p", prompt, "--dangerously-skip-permissions"]);
    if (res.code !== 0) return {};
    const json = extractJson(extractResult(stripAnsi(res.stdout)));
    if (!json) return {};
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const statuses: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) statuses[k.toUpperCase()] = v.trim();
    }
    jiraStatusCache.set(cacheKey, { statuses, at: Date.now() });
    return statuses;
  } catch {
    return {};
  }
}
```

with this:

```ts
const JIRA_STATUS_TTL_MS = 5 * 60 * 1000;

/** The claude -p round-trip for a batch of keys: `{ KEY: statusName }`, {} on failure. */
async function fetchJiraStatusBatch(keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const prompt =
    "You are a data extractor, not an agent. Do exactly two things and nothing else:\n" +
    `1. Run searchJiraIssuesUsingJql (Atlassian cloud id ${JIRA_CLOUD_ID}) with jql ` +
    `'key in (${keys.join(",")})' and fields ["status"].\n` +
    "2. Output ONLY a JSON object between <result> and </result> tags mapping each issue key " +
    'to its status name, e.g. {"PROJ-1234":"In Progress"}. Omit keys you could not fetch. ' +
    "Do not create, edit, transition, or comment on anything; write no prose outside the tags.\n" +
    "If the search fails entirely, output <result>{}</result> and nothing else.";
  try {
    const bin = await resolveClaudeBin();
    const res = await runCapture(bin, ["-p", prompt, "--dangerously-skip-permissions"]);
    if (res.code !== 0) return {};
    const json = extractJson(extractResult(stripAnsi(res.stdout)));
    if (!json) return {};
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const statuses: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) statuses[k.toUpperCase()] = v.trim();
    }
    return statuses;
  } catch {
    return {};
  }
}

/**
 * Current Jira status per issue key. Per-key persistent cache (5-min TTL):
 * fresh/stale keys are served from ~/.sandbox/jira-cache.json (stale ones
 * background-revalidated), only genuine misses hit claude -p. `refresh` forces
 * every key to re-fetch. Best-effort: keys claude can't return are omitted (and
 * not cached, so they retry next call).
 */
export async function getJiraStatuses(
  keys: string[],
  opts?: { refresh?: boolean },
): Promise<Record<string, string>> {
  const valid = [...new Set(keys.map((k) => parseJiraKey(k)).filter((k): k is string => !!k))].sort(
    (a, b) => a.localeCompare(b),
  );
  if (!valid.length) return {};

  const result: Record<string, string> = {};
  const misses: string[] = [];
  const stale: string[] = [];

  if (opts?.refresh) {
    misses.push(...valid);
  } else {
    for (const key of valid) {
      const hit = await cacheGet<string>(`status:${key}`);
      if (!hit) {
        misses.push(key);
        continue;
      }
      result[key] = hit.v;
      if (Date.now() - hit.at >= JIRA_STATUS_TTL_MS) stale.push(key);
    }
  }

  // Stale keys were served from cache above — revalidate in the background,
  // deduped per key so overlapping opens don't double-spawn claude.
  if (stale.length) {
    runBatchOnce(
      stale.map((k) => `status:${k}`),
      async (freshKeys) => {
        const bare = freshKeys.map((k) => k.slice("status:".length));
        const fetched = await fetchJiraStatusBatch(bare);
        for (const [k, v] of Object.entries(fetched)) await cacheSet(`status:${k}`, v);
      },
    );
  }

  // Missing keys: block on one batched fetch, store each returned key.
  if (misses.length) {
    const fetched = await fetchJiraStatusBatch(misses);
    for (const [k, v] of Object.entries(fetched)) {
      result[k] = v;
      await cacheSet(`status:${k}`, v);
    }
  }

  return result;
}
```

- [ ] **Step 3: Add the `refresh` input to the jira-statuses tool**

In `server.ts`, update the `jira-statuses` tool. Change the `inputSchema` and the handler call:

```ts
      inputSchema: {
        keys: z.array(z.string()).describe("Jira issue keys, e.g. [\"PROJ-1234\", \"PROJ-1300\"]."),
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the cache and re-fetch every key from Jira."),
      },
```

and:

```ts
        const statuses = await getJiraStatuses(args.keys ?? [], { refresh: args.refresh });
```

- [ ] **Step 4: Verify the build typechecks**

Run: `cd apps/mcp-workspace && npm run build`
Expected: PASS — no `tsc` errors. (`getJiraStatuses` signature change is consumed only by `server.ts`, updated above.)

- [ ] **Step 5: Re-run the cache smoke test (regression guard)**

Run: `node lib/cache.smoke.mjs`
Expected: `cache.smoke: OK`.

- [ ] **Step 6: Commit**

```bash
git add apps/mcp-workspace/lib/sandbox.ts apps/mcp-workspace/server.ts
git commit -m "feat(mcp-workspace): per-key persistent Jira status cache + refresh flag"
```

---

### Task 3: Route the form briefing through the persistent cache

**Files:**
- Modify: `apps/mcp-workspace/lib/sandbox.ts` (`buildRefineContext` ~L303-311; `fetchJiraFormData` ~L537; remove `jiraBriefingCache`, `getCachedJiraBriefing`, `setCachedJiraBriefing` ~L254-270)

**Interfaces:**
- Consumes (from Task 1): `cacheSet`, `withCache`.
- Keeps: `JIRA_BRIEFING_TTL_MS` constant; `fetchJiraTicketContext(key): Promise<string | null>`.

- [ ] **Step 1: Add `withCache` to the cache import**

Update the import added in Task 2 (in `lib/sandbox.ts`) to also bring in `withCache`:

```ts
import { cacheGet, cacheSet, runBatchOnce, withCache } from "./cache.js";
```

- [ ] **Step 2: Remove the in-memory briefing cache + helpers**

In `lib/sandbox.ts`, delete `getCachedJiraBriefing` and `setCachedJiraBriefing` and the `jiraBriefingCache` Map, keeping the `JIRA_BRIEFING_TTL_MS` constant. Delete this block:

```ts
const jiraBriefingCache = new Map<string, { briefing: string | null; at: number }>();

/** Cached briefing for `key`: a string, `null` (fetched-but-empty), or `undefined` (never fetched / expired). */
function getCachedJiraBriefing(key: string): string | null | undefined {
  const hit = jiraBriefingCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > JIRA_BRIEFING_TTL_MS) {
    jiraBriefingCache.delete(key);
    return undefined;
  }
  return hit.briefing;
}

function setCachedJiraBriefing(key: string, briefing: string | null): void {
  jiraBriefingCache.set(key, { briefing, at: Date.now() });
}
```

Leave the line `const JIRA_BRIEFING_TTL_MS = 15 * 60 * 1000;` in place.

- [ ] **Step 3: Route buildRefineContext through withCache**

In `lib/sandbox.ts` `buildRefineContext`, replace:

```ts
    let ticket = getCachedJiraBriefing(jiraKey);
    if (ticket === undefined) {
      ticket = await fetchJiraTicketContext(jiraKey);
      setCachedJiraBriefing(jiraKey, ticket);
    } else {
      console.error(`[sandbox-workspace] reusing cached Jira ${jiraKey} briefing for refine`);
    }
    if (ticket) {
```

with:

```ts
    // stale-while-revalidate: reuse the cached briefing (incl. a cached `null`
    // "fetched-but-empty"); only fetch on a cold miss. Persisted across
    // processes so form-open and later refine clicks share it.
    const ticket = await withCache(
      `briefing:${jiraKey}`,
      JIRA_BRIEFING_TTL_MS,
      () => fetchJiraTicketContext(jiraKey),
    );
    if (ticket) {
```

- [ ] **Step 4: Route fetchJiraFormData's briefing write through cacheSet**

In `lib/sandbox.ts` `fetchJiraFormData`, replace:

```ts
  setCachedJiraBriefing(key, briefing);
```

with:

```ts
  await cacheSet(`briefing:${key}`, briefing);
```

- [ ] **Step 5: Verify the build typechecks**

Run: `cd apps/mcp-workspace && npm run build`
Expected: PASS — no `tsc` errors, and no remaining references to `jiraBriefingCache`/`getCachedJiraBriefing`/`setCachedJiraBriefing` (a leftover reference would fail the build).

- [ ] **Step 6: Grep to confirm the Maps are gone**

Run: `grep -nE "jiraBriefingCache|jiraStatusCache|getCachedJiraBriefing|setCachedJiraBriefing" apps/mcp-workspace/lib/sandbox.ts`
Expected: no output (all retired).

- [ ] **Step 7: Commit**

```bash
git add apps/mcp-workspace/lib/sandbox.ts
git commit -m "refactor(mcp-workspace): route Jira briefing through persistent cache"
```

---

### Task 4: Topbar ↻ Refresh control

**Files:**
- Modify: `apps/mcp-workspace/src/workspace-ui.ts` (`loadJiraStatuses` ~L478-492; `initTopBar` ~L319-449; `load` ~L1051)

**Interfaces:**
- Consumes: the `jira-statuses` tool's new `refresh` input (Task 2).
- Produces: `loadJiraStatuses(keys: string[], refresh?: boolean): Promise<void>` and a topbar button that reloads with refresh.

- [ ] **Step 1: Thread `refresh` through loadJiraStatuses**

In `src/workspace-ui.ts`, change the signature and the tool call. Replace:

```ts
  async function loadJiraStatuses(keys: string[]): Promise<void> {
```

with:

```ts
  async function loadJiraStatuses(keys: string[], refresh = false): Promise<void> {
```

and replace:

```ts
          const d = await call("jira-statuses", { keys: chunk });
```

with:

```ts
          const d = await call("jira-statuses", { keys: chunk, refresh });
```

- [ ] **Step 2: Add a refresh entry point on the load path**

In `src/workspace-ui.ts`, `load` currently calls `loadJiraStatuses(keys)`. Give `load` an optional flag so the topbar button can force a refresh. Replace:

```ts
  async function load(): Promise<void> {
```

with:

```ts
  async function load(opts?: { refreshJira?: boolean }): Promise<void> {
```

and, in the `Promise.all` inside `load`, replace:

```ts
        keys.length ? loadJiraStatuses(keys) : Promise.resolve(),
```

with:

```ts
        keys.length ? loadJiraStatuses(keys, opts?.refreshJira) : Promise.resolve(),
```

- [ ] **Step 3: Add the ↻ Refresh button to the topbar**

In `src/workspace-ui.ts` `initTopBar`, after the kube block appends `msg` (the line `bar.appendChild(msg);`), add a refresh control that re-runs `load` with a Jira refresh:

```ts
    // Force-refresh the claude-backed Jira status cache (bypasses ~/.sandbox
    // jira-cache.json). Other data reloads too; only Jira skips its cache.
    bar.appendChild(el("span", "tb-sep", "|"));
    const jiraRefresh = el("button", "btn tb-btn tb-gke", "↻ Refresh Jira") as HTMLButtonElement;
    jiraRefresh.title = "Re-fetch Jira statuses from Atlassian, bypassing the cache";
    jiraRefresh.addEventListener("click", () => {
      jiraRefresh.disabled = true;
      void load({ refreshJira: true }).finally(() => (jiraRefresh.disabled = false));
    });
    bar.appendChild(jiraRefresh);
```

- [ ] **Step 4: Build the UI bundle**

Run: `cd apps/mcp-workspace && npm run build`
Expected: PASS — Vite rebuilds `dist/browser.html` (+ the other surfaces) and the server `tsc` build succeeds.

- [ ] **Step 5: Behavioral verification in the browser**

The dashboard server serves `dist/browser.html` fresh per request (`lib/browser-ui.ts` `GET /`). With a server running on `:3001` (`node dist/main.js`):
1. Load `http://localhost:3001/`; confirm the topbar shows a **↻ Refresh Jira** button next to the Kube section.
2. Click it; confirm the button disables during the reload and the status pills repaint (they may briefly show the `…` loader for keys that re-fetch).
3. Confirm no console errors and the `jira-statuses` request payload includes `"refresh":true` (DevTools Network).

- [ ] **Step 6: Commit**

```bash
git add apps/mcp-workspace/src/workspace-ui.ts apps/mcp-workspace/dist
git commit -m "feat(mcp-workspace): topbar force-refresh for Jira status cache"
```

---

## Self-Review

**Spec coverage:**
- Persist + cross-process → Task 1 (`~/.sandbox/jira-cache.json`, atomic merge). ✓
- Per-key status caching → Task 2 (`status:<KEY>`, partition fresh/stale/miss). ✓
- Stale-while-revalidate + dedupe → Task 1 (`withCache`, `runBatchOnce`, `inFlight`), used in Tasks 2–3. ✓
- Briefing migration incl. `null` semantics → Task 3 (`withCache` + `cacheSet`, `null` preserved). ✓
- Force-refresh control → Task 2 (`refresh` on tool + `getJiraStatuses`) + Task 4 (topbar button). ✓
- No auto-invalidation (Jira not mutated locally) → honored; nothing wired. ✓
- Out-of-scope reads untouched → no task modifies PRs/status/gke/kube. ✓
- Test → Task 1 `lib/cache.smoke.mjs`. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The shell-out paths (Tasks 2–3) are verified by `tsc` typecheck + grep + the Task 4 behavioral check rather than unit tests, because `getJiraStatuses`/`fetchJiraTicketContext` call the live `claude`/Atlassian stack and aren't injectable — the cache logic they depend on is fully unit-tested in Task 1.

**Type consistency:** `getJiraStatuses(keys, opts?)` defined in Task 2, consumed in `server.ts` (Task 2) and unchanged in the UI (which calls the tool, not the function). `cacheGet`/`cacheSet`/`runBatchOnce`/`withCache` signatures defined in Task 1 match every call site in Tasks 2–3. `briefing:`/`status:` prefixes consistent across tasks. `loadJiraStatuses(keys, refresh?)` and `load({ refreshJira? })` consistent within Task 4.
