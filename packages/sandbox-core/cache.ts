/**
 * Persistent, cross-process TTL cache for the issue-tracker lookups
 * (status pills + form briefing). One JSON file at ~/.sandbox/issue-cache.json
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
  return process.env.SANDBOX_CACHE_FILE || path.join(os.homedir(), ".sandbox", "issue-cache.json");
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
      //
      // Deliberately still console, not the reporter: this module is reached
      // only through sandbox.ts, whose consumers (the dashboard, the VS Code
      // extension) install no reporter, so an emitted event would go nowhere
      // and these diagnostics would vanish. See note 033.
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
    .catch((e) =>
      console.error("[sandbox-workspace] background cache refresh failed:", (e as Error).message),
    )
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
