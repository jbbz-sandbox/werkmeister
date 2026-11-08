/**
 * SW-35: the sandbox repo's containers share one bounded turbo cache. The
 * bound is turbo's own `TURBO_CACHE_MAX_AGE` eviction, so the eviction cases
 * drive the repo's real turbo binary against a throwaway monorepo and cache
 * dir: a turbo upgrade that stops evicting fails here, not on a full disk.
 * SW-69: the cache is the built-in `turbo` entry, attached by turbo.json.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCaches } from "werkmeister-core/build_caches";
import { REGISTRY_DEFAULTS } from "werkmeister-core/scaffold";
import YAML from "yaml";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../../../../../..");
const TURBO = path.join(REPO, "node_modules", ".bin", "turbo");
const execFileAsync = promisify(execFile);
const BUILT_IN = REGISTRY_DEFAULTS.caches.turbo;
const MAX_AGE: string = BUILT_IN.env.TURBO_CACHE_MAX_AGE;

// SW-402: a case runs turbo up to three times, ~1 s each when idle and 10-50x that on a loaded host.
vi.setConfig({ testTimeout: 180_000 });

// biome-ignore lint/suspicious/noExplicitAny: the registry is untyped YAML.
const registry: any = YAML.parse(
  fs.readFileSync(path.join(REPO, ".werkmeister", "services.yaml"), "utf8"),
);

describe("the built-in turbo cache on this repo's services", () => {
  it("points turbo at its own mount and prunes at turbo's own max age", () => {
    expect(BUILT_IN.env.TURBO_CACHE_DIR).toBe(BUILT_IN.path);
    expect(BUILT_IN.max_age).toBe(MAX_AGE);
    expect(BUILT_IN.detect).toContain("turbo.json");
  });

  it("reaches the install and every service it feeds through turbo.json alone", () => {
    const repo = path.basename(REPO);
    const withRepo = (defs: Record<string, object>) =>
      Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, { ...d, repo }]));
    const [services, setups] = applyCaches(
      withRepo(registry.services),
      withRepo(registry.setup_services),
      {},
      REGISTRY_DEFAULTS.caches,
      path.dirname(REPO),
    );
    const fed = Object.keys(services).filter(
      (n) => services[n]?.setup_service === "werkmeister-install",
    );
    expect(fed.sort()).toEqual([
      "cli",
      "docs-site",
      "github-ingest",
      "werkmeister-core",
      "werkmeister-dashboard",
      "werkmeister-vscode",
    ]);
    for (const def of [setups["werkmeister-install"], ...fed.map((n) => services[n])]) {
      expect(def?.extra_volumes).toContain(`^werkmeister-turbo:${BUILT_IN.path}`);
      expect(def?.environment?.TURBO_CACHE_DIR).toBe(BUILT_IN.path);
      expect(def?.environment?.TURBO_CACHE_MAX_AGE).toBe(MAX_AGE);
    }
  });
});

let tmp: string;
let fixture: string;
let cache: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

async function turbo(...args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmp,
    TURBO_CACHE_DIR: cache,
    TURBO_CACHE_MAX_AGE: MAX_AGE,
    TURBO_TELEMETRY_DISABLED: "1",
  };
  delete env.TURBO_FORCE;
  // SW-402: async, so a starved turbo run never blocks the vitest worker past its 60 s RPC timeout.
  const { stdout } = await execFileAsync(TURBO, ["run", "build", ...args], { cwd: fixture, env });
  return stdout;
}

/** A cache entry as turbo writes one: archive plus metadata sidecar. */
function seedEntry(hash: string, ageDays: number): string[] {
  const files = [path.join(cache, `${hash}.tar.zst`), path.join(cache, `${hash}-meta.json`)];
  fs.writeFileSync(files[0], "x");
  fs.writeFileSync(files[1], JSON.stringify({ hash, duration: 1 }));
  const when = new Date(Date.now() - ageDays * 86_400_000);
  for (const f of files) fs.utimesSync(f, when, when);
  return files;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-cache-"));
  fixture = path.join(tmp, "repo");
  cache = path.join(tmp, "cache");
  fs.mkdirSync(cache);
  writeJson(path.join(fixture, "package.json"), {
    name: "fixture",
    private: true,
    packageManager: "npm@10.9.0",
    workspaces: ["packages/*"],
  });
  writeJson(path.join(fixture, "packages", "a", "package.json"), {
    name: "a",
    scripts: { build: "mkdir -p dist && echo built > dist/out" },
  });
  writeJson(path.join(fixture, "package-lock.json"), {
    name: "fixture",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture", workspaces: ["packages/*"] },
      "packages/a": { name: "a" },
      "node_modules/a": { resolved: "packages/a", link: true },
    },
  });
  writeJson(path.join(fixture, "turbo.json"), { tasks: { build: { outputs: ["dist/**"] } } });
  // Without it the build's dist/ and turbo's own task log become inputs, and
  // every rerun misses.
  fs.writeFileSync(path.join(fixture, ".gitignore"), "dist\n.turbo\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!fs.existsSync(TURBO))("turbo with the registry's cache settings", () => {
  it("evicts entries older than TURBO_CACHE_MAX_AGE and keeps newer ones", async () => {
    const maxDays = Number.parseInt(MAX_AGE, 10);
    const stale = seedEntry("aaaaaaaaaaaaaaaa", maxDays + 6);
    const fresh = seedEntry("bbbbbbbbbbbbbbbb", maxDays - 1);

    await turbo();

    for (const f of stale) expect(fs.existsSync(f), f).toBe(false);
    for (const f of fresh) expect(fs.existsSync(f), f).toBe(true);
    // The run's own entry lands in TURBO_CACHE_DIR, not the repo's .turbo.
    expect(fs.readdirSync(cache).filter((f) => f.endsWith(".tar.zst"))).toHaveLength(2);
    expect(fs.existsSync(path.join(fixture, ".turbo", "cache"))).toBe(false);
  });

  it("hits on unchanged inputs, and --force still bypasses the cache", async () => {
    expect(await turbo()).toContain("0 cached, 1 total");
    expect(await turbo()).toContain("1 cached, 1 total");
    expect(await turbo("--force")).toContain("0 cached, 1 total");
  });

  // SW-361: esbuild.mjs bakes HEAD and the dirty flag into the CLI, and neither is
  // a turbo input, so a bundle built before a commit of the same content replayed
  // with a stale stamp and bins.test.ts failed on the notice. The bundle takes
  // under a second: this repo never caches it.
  it("never caches the CLI bundle, whose stamp is not an input", async () => {
    const { stdout } = await execFileAsync(
      TURBO,
      ["run", "build", "--filter=werkmeister", "--dry-run=json"],
      { cwd: REPO, env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" } },
    );
    const tasks: { taskId: string; resolvedTaskDefinition: { cache: boolean } }[] =
      JSON.parse(stdout).tasks;
    expect(tasks.find((t) => t.taskId === "werkmeister#build")?.resolvedTaskDefinition.cache).toBe(
      false,
    );
  });
});
