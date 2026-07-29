# Persistent, cross-process TTL cache for the claude-backed Jira paths

**Date:** 2026-07-11
**Component:** `apps/mcp-workspace`
**Status:** Approved design — ready for implementation plan

## Problem

The workspace dashboard's Jira data comes from shelling out to `claude -p`, which
drives the Atlassian MCP. Two paths do this and are the only expensive
`claude -p` reads on the dashboard:

- **`getJiraStatuses(keys)`** (`lib/sandbox.ts`) — the list's Jira status pills.
  Spawns `claude -p` to run `searchJiraIssuesUsingJql`. The list UI chunks keys
  into groups of 5, so a cold load spawns one agent per chunk (~3 for ~15 keys).
- **`fetchJiraFormData` briefing** (`lib/sandbox.ts`) — the New-workspace form's
  Jira autofill/briefing.

Each already has an **in-memory `Map` cache** (`jiraStatusCache`, 5-min TTL,
keyed by the comma-joined chunk; `jiraBriefingCache`, 15-min TTL, keyed by Jira
key). Every dashboard surface (browser, Cowork artifact, MCP inline) routes tool
calls through the one long-lived MCP server process, so those caches are shared
across dashboard opens today.

Three gaps remain (the ones this design targets):

1. **Lost on restart / not cross-process.** The `Map`s live in the server
   process. A server restart cold-starts every Jira lookup, and the separate
   short-lived browser-form CLI process can't share them.
2. **Chunk-keyed status cache misses too easily.** Keying on the comma-joined
   chunk means adding one workspace or reordering shifts chunk membership and
   misses the cache for all keys in that chunk, even when most are unchanged.
3. **No explicit control.** No way to force a fresh fetch when you know Jira
   changed.

Explicitly **out of scope** (kept live, per product decision): caching
`workspace-prs` (`gh`), `workspace-status` (`docker`), `gke-forwards-status`,
`kube-context`.

## Goals

- Persist the two claude-backed Jira caches to disk so they survive server
  restarts and are shared across processes.
- Re-key the status cache **per Jira key** for a high hit rate.
- Add a manual **force-refresh** control.
- No new dependencies; follow existing `~/.sandbox/` conventions (`slots.json`).

## Staleness model — uniform stale-while-revalidate

One strategy for both Jira paths:

- **Cold miss** (no entry) → block, fetch, store, return. Same as today; the
  list UI already shows a `st-loading` `…` chip and fills progressively, so no
  regression.
- **Expired-but-present** → return the stale value immediately, and fire a
  **background** `claude -p` refresh that writes the fresh value for the next
  read. The pill never blocks on expiry.
- **Force-refresh** → bypass the read, re-fetch, store.

Deliberately **no live push**: the refreshed value lands on the next dashboard
open/poll rather than being streamed into the current pill. This avoids new
SSE/websocket plumbing for a cosmetic gain. Jira status changes ~once a day, so
a few-minutes-stale pill is harmless, and force-refresh is the escape hatch.

**Dedupe guard.** An expired read triggers a background `claude -p`, which costs
tokens whether or not anyone is waiting. A per-key in-flight `Set<string>`
ensures at most one background refresh per key at a time. Reads happen only on
dashboard open (not a tight loop), so this fully bounds background spawns.

## Architecture

### New module: `lib/cache.ts`

A small persistent TTL cache — the shared mechanism for both Jira paths.

**Backing store:** `~/.sandbox/jira-cache.json` (next to `slots.json`; path via a
single constant). Shape:

```json
{
  "status:PROJ-1839":   { "v": "In Development", "at": 1752000000000 },
  "briefing:PROJ-1839": { "v": "…briefing text…", "at": 1752000000000 }
}
```

Keys are namespaced (`status:<KEY>`, `briefing:<KEY>`) so both paths share one
file without collision. `v` is the cached value; `at` is the store time (ms).

**Reads:** load + parse the file on demand. A corrupt/missing file is treated as
empty (never throws to the caller).

**Writes (serialized + atomic merge):** writes are serialized within the process
(a write chain) so concurrent `cacheSet` calls each read-modify-write one at a
time and see prior writes; each commit reads the latest file → merges the one
changed key → writes a unique temp file → `fs.rename` over the target. This
makes in-process concurrency (two dashboard opens, a `Promise.all`) lossless;
separate processes still race. Whole-file rewrite is fine at this scale.

> `// ponytail: whole-file read-modify-write + last-write-wins; the merge closes
> the common race, a torn interleaving at worst re-fetches one key. Go SQLite
> only if entries ever reach the thousands.`

**Primitives** (used directly by the batched status path):

```
cacheGet<T>(key: string): { v: T; at: number } | undefined   // reads the file
cacheSet<T>(key: string, v: T): Promise<void>                 // atomic merge-write
runOnce(key: string, job: () => Promise<void>): void          // deduped bg via in-flight Set
```

**Convenience wrapper** (single-key paths, e.g. the briefing):

```
withCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T | undefined>,
             opts?: { refresh?: boolean }): Promise<T | undefined>
```

`withCache` behavior, built on the primitives + a shared in-flight `Set`:

- `opts.refresh` → skip read; `await fetcher()`; `cacheSet` on success; return.
- `cacheGet(key)`:
  - **fresh** (`now - at < ttlMs`) → return `v`.
  - **stale** (`now - at >= ttlMs`) → return `v`; `runOnce(key, fetch→cacheSet)`.
  - **missing** → `await fetcher()`; `cacheSet` on success; return.

The batched `getJiraStatuses` does not use `withCache` (which is one fetcher per
key); it calls `cacheGet` to partition, runs one batched `claude -p`, `cacheSet`s
each returned key, and uses `runOnce` to dedupe the background batch. `runOnce`
is keyed on the individual Jira key so a batch and a single-key briefing never
double-fetch the same underlying entry.

**Failure safety:** `fetcher` returning `undefined` (failure / not found) is
**not stored** — so a failed lookup never becomes a permanent cached empty; it
simply retries on the next read. For `getJiraStatuses`, a Jira key that
`claude -p` did not return is left unwritten and retried next open.

### Wiring into the Jira paths

Retire the two in-memory `Map`s (`jiraStatusCache`, `jiraBriefingCache`) in favor
of `lib/cache.ts`. TTLs unchanged: **5 min** status, **15 min** briefing.

**`getJiraStatuses(keys, opts?: { refresh?: boolean })`** — re-keyed **per Jira
key**:

1. Normalize/dedupe keys (existing logic).
2. Partition into cache-fresh (from `status:<KEY>` entries) and misses. `refresh`
   forces all into "miss".
3. Fetch only the **missing** keys via `claude -p` (still chunked by 5 for
   prompt size); `cacheSet` each returned key (`status:<KEY>`). Keys absent from
   the result are left unwritten (retry next open).
4. **Stale** keys (present but expired) are returned from cache immediately and
   collected into a single background batch fetched via `runOnce` (deduped per
   key), which `cacheSet`s each result for the next open.
5. Return the merged map (fresh + stale-from-cache + newly fetched) for the
   requested keys.

**`fetchJiraFormData` briefing** → `withCache('briefing:<KEY>', 15min, fetcher,
{ refresh })`.

### Control / invalidation

- Add `refresh?: boolean` to the **`jira-statuses` tool** input schema
  (`server.ts`), threaded into `getJiraStatuses`.
- **UI:** one small **↻ Refresh** control in the dashboard topbar
  (`src/workspace-ui.ts`, `initTopBar`) that reloads the list, passing
  `refresh: true` to the `jira-statuses` call. Rebuild via `npm run build`.
- **No auto-invalidation:** local workspace actions do not mutate Jira, so there
  is nothing to bust automatically. Force-refresh is the only control needed.
  (If `workspace-prs`/`workspace-status` are cached later, those would get
  action-triggered invalidation — not part of this work.)

## Data flow (status pills, warm server)

```
dashboard load → jira-statuses(keys)
  → getJiraStatuses partitions keys by status:<KEY> freshness
     fresh  → returned from ~/.sandbox/jira-cache.json immediately
     stale  → returned immediately + deduped background claude -p → store
     miss   → claude -p (chunked) → store each key → return
  → pills render; stale/missing keys converge on next open
force-refresh (↻) → jira-statuses(keys, refresh:true) → all keys re-fetched
```

## Error handling

- Corrupt/unreadable cache file → treated as empty; caller proceeds as a cold
  miss. Never throws to the tool layer.
- `fetcher` failure (`undefined`) → not stored; stale value (if any) remains
  served; retried next read.
- Atomic write failure (rename/temp error) → logged and swallowed; the cache is
  best-effort and a write miss only costs a future re-fetch.
- Background refresh rejection → caught, removed from in-flight set; never
  surfaces to the user.

## Testing

`lib/cache.smoke.mjs` (matches the existing `lib/session-stream.smoke.mjs`
pattern — plain Node, `assert`, no framework), using a temp cache file:

- fresh entry → served without calling the fetcher;
- expired entry → stale value returned synchronously **and** fetcher runs in the
  background, updating the store;
- cold miss → blocks on fetcher, stores, returns;
- `refresh: true` → bypasses a fresh entry and re-fetches;
- failed fetch (`undefined`) → nothing stored, stale (if any) preserved;
- concurrent write merges rather than clobbers (write key A and key B against the
  same file; both survive).

## Files touched

- **New:** `apps/mcp-workspace/lib/cache.ts`
- **New:** `apps/mcp-workspace/lib/cache.smoke.mjs`
- **Modified:** `apps/mcp-workspace/lib/sandbox.ts` — retire the two Maps; re-key
  `getJiraStatuses` per key + add `refresh`; route briefing through `withCache`.
- **Modified:** `apps/mcp-workspace/server.ts` — add `refresh` to the
  `jira-statuses` tool input.
- **Modified:** `apps/mcp-workspace/src/workspace-ui.ts` — ↻ Refresh control in
  the topbar; pass `refresh: true` on force-reload.
- Rebuild: `npm run build` (regenerates `dist/*.html`).

## Out of scope

- Caching `workspace-prs`, `workspace-status`, `gke-forwards-status`,
  `kube-context`.
- Live push of refreshed values into rendered pills.
- SQLite / any new dependency.
