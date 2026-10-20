/**
 * SW-35: the sandbox repo's containers share one bounded turbo cache. The
 * bound is turbo's own `TURBO_CACHE_MAX_AGE` eviction, so the eviction cases
 * drive the repo's real turbo binary against a throwaway monorepo and cache
 * dir: a turbo upgrade that stops evicting fails here, not on a full disk.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../../../../../..");
const TURBO = path.join(REPO, "node_modules", ".bin", "turbo");
const CACHE_DIR = "{{home}}/.sandbox/cache/turbo";

// biome-ignore lint/suspicious/noExplicitAny: the registry is untyped YAML.
const registry: any = YAML.parse(
  fs.readFileSync(path.join(REPO, ".sandbox", "services.yaml"), "utf8"),
);
const MAX_AGE: string = registry.setup_services["sandbox-install"].environment.TURBO_CACHE_MAX_AGE;

describe("services.yaml turbo cache wiring", () => {
  const appServices = Object.entries(registry.services).filter(
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    ([, def]: [string, any]) => def.setup_service === "sandbox-install",
  );

  it("covers the install and every service it feeds", () => {
    expect(appServices.map(([name]) => name).sort()).toEqual(
      ["cli", "sandbox-core", "sandbox-dashboard", "vscode-plugin"].sort(),
    );
  });

  it.each([
    ["sandbox-install", registry.setup_services["sandbox-install"]],
    ...appServices,
    // biome-ignore lint/suspicious/noExplicitAny: see above.
  ])("%s sets one explicit, bounded TURBO_CACHE_DIR and can reach it", (_name, def: any) => {
    expect(def.environment.TURBO_CACHE_DIR).toBe(CACHE_DIR);
    expect(def.environment.TURBO_CACHE_MAX_AGE).toBe(MAX_AGE);
    // The host dir itself, or the ~/.sandbox it lives in, at the same path.
    const mounts: string[] = def.extra_volumes;
    expect(
      mounts.includes(`${CACHE_DIR}:${CACHE_DIR}`) ||
        mounts.includes("{{home}}/.sandbox:{{home}}/.sandbox"),
    ).toBe(true);
  });
});

let tmp: string;
let fixture: string;
let cache: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function turbo(...args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmp,
    TURBO_CACHE_DIR: cache,
    TURBO_CACHE_MAX_AGE: MAX_AGE,
    TURBO_TELEMETRY_DISABLED: "1",
  };
  delete env.TURBO_FORCE;
  const res = spawnSync(TURBO, ["run", "build", ...args], { cwd: fixture, env, encoding: "utf8" });
  expect(res.status, res.stdout + res.stderr).toBe(0);
  return res.stdout;
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
  it("evicts entries older than TURBO_CACHE_MAX_AGE and keeps newer ones", () => {
    const maxDays = Number.parseInt(MAX_AGE, 10);
    const stale = seedEntry("aaaaaaaaaaaaaaaa", maxDays + 6);
    const fresh = seedEntry("bbbbbbbbbbbbbbbb", maxDays - 1);

    turbo();

    for (const f of stale) expect(fs.existsSync(f), f).toBe(false);
    for (const f of fresh) expect(fs.existsSync(f), f).toBe(true);
    // The run's own entry lands in TURBO_CACHE_DIR, not the repo's .turbo.
    expect(fs.readdirSync(cache).filter((f) => f.endsWith(".tar.zst"))).toHaveLength(2);
    expect(fs.existsSync(path.join(fixture, ".turbo", "cache"))).toBe(false);
  });

  it("hits on unchanged inputs, and --force still bypasses the cache", () => {
    expect(turbo()).toContain("0 cached, 1 total");
    expect(turbo()).toContain("1 cached, 1 total");
    expect(turbo("--force")).toContain("0 cached, 1 total");
  });
});
