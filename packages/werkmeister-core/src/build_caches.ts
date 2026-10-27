/**
 * Build and package caches (SW-69): the registry's `caches:` catalogue.
 *
 * A cache is data — a mount point, the env that points a tool at it, the
 * files that mean a repo uses that tool, and how to prune it — so a new
 * toolchain is a registry entry, not code. Compose generation reads it through
 * `applyCaches`; `werkmeister status` and `cache prune` read the same entries.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { resolveServiceArchetype } from "./archetypes.js";
import {
  type ArchetypeRegistry,
  type CacheEntry,
  type CacheRegistry,
  loadCaches,
  type ServiceEntry,
  type ServicesConfig,
} from "./config.js";
import { runningContainersMounting, type VolumeUsage, volumeUsage } from "./docker.js";
import { type RunResult, run } from "./proc.js";

export interface CacheSource {
  kind: "volume" | "host";
  name: string;
}

/** Volume or host dir a cache lives in: `host` wins, else `volume`, else `werkmeister-<key>`. */
export function cacheSource(key: string, cache: CacheEntry): CacheSource {
  if (cache.host) return { kind: "host", name: cache.host };
  return { kind: "volume", name: cache.volume ?? `werkmeister-${key}` };
}

/** The default volume before SW-93, left behind on machines that had it; SW-11 drops it. */
function legacyCacheVolume(key: string, cache: CacheEntry): string | null {
  return cache.host || cache.volume ? null : `sandbox-${key}`; // name-check: ignore
}

/** True when one of *files* is in *from* or a parent of it, up to and including *root*. */
function detectedIn(files: string[], from: string, root: string): boolean {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (files.some((f) => fs.existsSync(path.join(dir, f)))) return true;
    if (dir === root || !dir.startsWith(root)) return false;
  }
}

/**
 * Cache keys *svc* gets: its own `caches:` when set (`[]` opts out), else its
 * archetype's `caches` plus every cache whose `detect` file is in its repo.
 * *repoDir* is the checkout compose mounts, so a branch that adds a lockfile
 * gets that cache; null skips detection.
 */
export function serviceCaches(
  name: string,
  svc: ServiceEntry,
  archetypes: ArchetypeRegistry,
  caches: CacheRegistry,
  repoDir: string | null,
): string[] {
  let keys: string[];
  if (Array.isArray(svc.caches)) {
    keys = [...svc.caches];
  } else {
    const fromArchetype = resolveServiceArchetype(svc, archetypes)?.caches ?? [];
    const detected =
      repoDir && fs.existsSync(repoDir)
        ? Object.keys(caches).filter((k) => {
            const files = caches[k]?.detect ?? [];
            return (
              files.length > 0 &&
              detectedIn(files, path.resolve(repoDir, svc.path ?? "."), path.resolve(repoDir))
            );
          })
        : [];
    keys = [...new Set([...fromArchetype, ...detected])];
  }
  for (const k of keys) {
    if (!(k in caches)) {
      throw new Error(
        `services.yaml: service '${name}' names unknown cache '${k}' — no \`caches.${k}\` entry`,
      );
    }
  }
  return keys.sort();
}

/** A copy of *entry* with each cache's mount added and its env under the entry's own. */
function withCaches(entry: ServiceEntry, keys: string[], caches: CacheRegistry): ServiceEntry {
  const volumes = [...(entry.extra_volumes ?? [])];
  let env: Record<string, string> = {};
  for (const key of keys) {
    const cache = caches[key] as CacheEntry;
    const src = cacheSource(key, cache);
    const spec = `${src.kind === "volume" ? `^${src.name}` : src.name}:${cache.path}`;
    if (!volumes.includes(spec)) volumes.push(spec);
    env = { ...env, ...cache.env };
  }
  return { ...entry, extra_volumes: volumes, environment: { ...env, ...entry.environment } };
}

/**
 * Copies of *services* and *setups* with their caches' mounts and env merged in.
 * A setup service gets the union over every service that names it, local or
 * not, so its install fills the same store the apps read.
 */
export function applyCaches(
  services: ServicesConfig,
  setups: ServicesConfig,
  archetypes: ArchetypeRegistry,
  caches: CacheRegistry,
  workspaceRoot: string,
): [ServicesConfig, ServicesConfig] {
  if (Object.keys(caches).length === 0) return [services, setups];
  const outServices: ServicesConfig = {};
  const setupKeys = new Map<string, Set<string>>();
  for (const [name, svc] of Object.entries(services)) {
    const repoDir = svc.repo ? path.join(workspaceRoot, svc.repo) : null;
    const keys = serviceCaches(name, svc, archetypes, caches, repoDir);
    outServices[name] = keys.length ? withCaches(svc, keys, caches) : svc;
    if (svc.setup_service && keys.length) {
      const union = setupKeys.get(svc.setup_service) ?? new Set<string>();
      for (const k of keys) union.add(k);
      setupKeys.set(svc.setup_service, union);
    }
  }
  const outSetups: ServicesConfig = {};
  for (const [name, setup] of Object.entries(setups)) {
    const keys = [...(setupKeys.get(name) ?? [])].sort();
    outSetups[name] = keys.length ? withCaches(setup, keys, caches) : setup;
  }
  return [outServices, outSetups];
}

export interface CacheSnapshot {
  name: string;
  kind: "volume" | "host";
  source: string;
  exists: boolean;
  size_bytes: number | null;
  created_at: string | null;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += fs.statSync(path.join(e.parentPath, e.name)).size;
  }
  return total;
}

/**
 * One row per registry cache: where it lives, whether it exists yet, its size and
 * creation time. A leftover pre-SW-93 `sandbox-<key>` volume gets a second row, so // name-check: ignore
 * `status` shows it and `cache prune` reaches it.
 */
export async function cacheSnapshots(
  caches: CacheRegistry = loadCaches(),
  usage: Map<string, VolumeUsage> | null | undefined = undefined,
): Promise<CacheSnapshot[]> {
  usage ??= await volumeUsage();
  return Object.keys(caches)
    .sort()
    .flatMap((name) => {
      const cache = caches[name] as CacheEntry;
      const legacy = legacyCacheVolume(name, cache);
      const leftover = legacy ? usage?.get(legacy) : undefined;
      const src = cacheSource(name, cache);
      const row = snapshotOf(name, src, usage);
      return leftover && legacy
        ? [row, snapshotOf(name, { kind: "volume", name: legacy }, usage)]
        : [row];
    });
}

function snapshotOf(
  name: string,
  src: CacheSource,
  usage: Map<string, VolumeUsage> | null | undefined,
): CacheSnapshot {
  if (src.kind === "host") {
    const st = fs.statSync(src.name, { throwIfNoEntry: false });
    return {
      name,
      kind: src.kind,
      source: src.name,
      exists: Boolean(st),
      size_bytes: st ? dirSize(src.name) : null,
      created_at: st ? st.birthtime.toISOString() : null,
    };
  }
  const u = usage?.get(src.name);
  return {
    name,
    kind: src.kind,
    source: src.name,
    exists: Boolean(u),
    size_bytes: u && u.size >= 0 ? u.size : null,
    created_at: u?.createdAt ?? null,
  };
}

export interface PruneResult {
  name: string;
  action: "max_age" | "prune" | "reset" | "skipped";
  detail: string;
  ok: boolean;
}

export interface PruneOptions {
  name?: string;
  reset?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

/** Docker reads `pruneCaches` needs; tests swap these for fakes. */
export interface PruneDeps {
  caches: CacheRegistry;
  snapshots: (caches: CacheRegistry) => Promise<CacheSnapshot[]>;
  busy: (source: string) => Promise<string[] | null>;
  run: (argv: string[]) => RunResult;
}

const defaultDeps = (): PruneDeps => ({
  caches: loadCaches(),
  snapshots: (c) => cacheSnapshots(c),
  busy: runningContainersMounting,
  run: (argv) => run(argv, { capture: true }),
});

/**
 * Apply each cache's prune rule (`max_age`, else `prune`), or empty it with
 * *reset*. Everything runs in a throwaway container with the cache mounted, so
 * a host dir and a volume prune the same way. Never removes a volume: Docker
 * refuses while any stopped workspace container still references it.
 */
export async function pruneCaches(
  opts: PruneOptions = {},
  deps: PruneDeps = defaultDeps(),
): Promise<PruneResult[]> {
  const { caches } = deps;
  if (opts.name !== undefined && !(opts.name in caches)) {
    const known = Object.keys(caches).sort().join(", ") || "none";
    return [
      { name: opts.name, action: "skipped", detail: `unknown cache (known: ${known})`, ok: false },
    ];
  }
  const rows = (await deps.snapshots(caches)).filter(
    (r) => opts.name === undefined || r.name === opts.name,
  );
  const results: PruneResult[] = [];
  for (const row of rows) {
    const cache = caches[row.name] as CacheEntry;
    // The leftover pre-SW-93 volume's row says which volume it is.
    const name =
      row.source === cacheSource(row.name, cache).name ? row.name : `${row.name} (${row.source})`;
    const skip = (detail: string, ok = true) =>
      results.push({ name, action: "skipped", detail, ok });
    if (!row.exists) {
      // `docker run -v` would create the volume we are only meant to clean.
      skip("not created");
      continue;
    }
    let inUse = "";
    if (!opts.force) {
      const users = await deps.busy(row.source);
      if (users === null) {
        skip("Docker is unreachable", false);
        continue;
      }
      // A dry run is most useful while workspaces are up, so it reports instead of skipping.
      if (users.length && !opts.dryRun) {
        skip(`in use by ${users.join(", ")} (--force to prune anyway)`);
        continue;
      }
      if (users.length) inUse = ` (in use by ${users.join(", ")})`;
    }
    const dir = `'${cache.path}'`;
    let action: PruneResult["action"];
    let cmd: string;
    let env: string[] = [];
    if (opts.reset) {
      action = "reset";
      cmd = `find ${dir} -mindepth 1 -delete`;
    } else if (cache.max_age) {
      const days = /^([1-9][0-9]*)d$/.exec(cache.max_age)?.[1];
      if (!days) {
        skip(`max_age '${cache.max_age}' is not <N>d`, false);
        continue;
      }
      action = "max_age";
      // -mmin, not -mtime: -mtime rounds the age down, so +14 would mean 15 days.
      const old = `find ${dir} -mindepth 1 -type f -mmin +${Number(days) * 1440}`;
      cmd = opts.dryRun
        ? `${old} | wc -l`
        : `${old} -delete && find ${dir} -mindepth 1 -type d -empty -delete`;
    } else if (cache.prune) {
      action = "prune";
      cmd = cache.prune;
      env = Object.entries(cache.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    } else {
      skip("no prune rule; use --reset");
      continue;
    }
    if (opts.dryRun && action !== "max_age") {
      const size = row.size_bytes === null ? "unknown size" : `${row.size_bytes} bytes`;
      const detail = action === "reset" ? `would empty ${size}` : `would run: ${cmd}`;
      results.push({ name, action, detail: detail + inUse, ok: true });
      continue;
    }
    const argv = ["docker", "run", "--rm", "-v", `${row.source}:${cache.path}`, ...env];
    argv.push(cache.image ?? "node:22", "sh", "-c", cmd);
    const res = deps.run(argv);
    const out = res.stdout.trim();
    const detail =
      res.status !== 0
        ? res.stderr.trim() || `exit ${res.status}`
        : opts.dryRun
          ? `would delete ${out} file(s) older than ${cache.max_age}${inUse}`
          : out || "done";
    results.push({ name, action, detail, ok: res.status === 0 });
  }
  return results;
}
