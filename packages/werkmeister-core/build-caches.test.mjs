// SW-69: build and package caches are registry data. A service gets a cache
// from its own `caches:`, its archetype, or a lockfile in its repo; compose
// mounts it as a shared volume (or an opted-out host dir) on the service and
// its setup service. A new tool must need only a registry entry, which the
// yarn/cargo fixture below proves through the real template.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import YAML from "yaml";

import { applyCaches, cacheSnapshots, pruneCaches, serviceCaches } from "./dist/build_caches.js";
import { generateFeatureCompose } from "./dist/generate.js";
import { REGISTRY_DEFAULTS } from "./dist/scaffold.js";
import { withSandboxHome } from "./fixtures.mjs";

const CLI_ROOT = path.resolve(import.meta.dirname, "../../apps/cli");
const CACHES = {
  "pnpm-store": {
    path: "/pnpm-store",
    env: { npm_config_store_dir: "/pnpm-store" },
    detect: ["pnpm-lock.yaml"],
  },
  turbo: {
    path: "/turbo-cache",
    env: { TURBO_CACHE_DIR: "/turbo-cache" },
    detect: ["turbo.json"],
    max_age: "14d",
  },
  host: { path: "/h", host: "/var/cache/h" },
};

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-caches-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** `<tmp>/<rel>` with *files* touched in it; returns its path. */
function dirWith(rel, ...files) {
  const dir = path.join(tmp, rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  return dir;
}

test("serviceCaches: an explicit list wins, [] opts out, an unknown key fails", () => {
  const repo = dirWith("repo", "pnpm-lock.yaml");
  assert.deepEqual(serviceCaches("s", { caches: ["turbo"] }, {}, CACHES, repo), ["turbo"]);
  assert.deepEqual(serviceCaches("s", { caches: [] }, {}, CACHES, repo), []);
  assert.throws(
    () => serviceCaches("s", { caches: ["nope"] }, {}, CACHES, repo),
    /'s' names unknown cache 'nope'/,
  );
});

test("serviceCaches: archetype caches plus lockfiles from the service dir up to the repo root, not above", () => {
  dirWith(".", "turbo.json"); // above the repo: never seen
  const repo = dirWith("repo", "pnpm-lock.yaml");
  dirWith("repo/apps/web");
  const archetypes = { tool: { caches: ["host"] } };
  assert.deepEqual(
    serviceCaches("web", { path: "apps/web", archetype: "tool" }, archetypes, CACHES, repo),
    ["host", "pnpm-store"],
  );
  dirWith("repo/apps/web", "turbo.json");
  assert.deepEqual(serviceCaches("web", { path: "apps/web" }, {}, CACHES, repo), [
    "pnpm-store",
    "turbo",
  ]);
  assert.deepEqual(serviceCaches("web", { path: "apps/web" }, {}, CACHES, null), []);
});

test("applyCaches: volume and host mounts, service env wins, setup gets the union, inputs untouched", () => {
  dirWith("ws/demo", "pnpm-lock.yaml");
  const services = {
    a: {
      repo: "demo",
      setup_service: "inst",
      environment: { TURBO_CACHE_DIR: "/mine" },
      caches: ["turbo", "host"],
    },
    b: { repo: "demo", setup_service: "inst" },
    c: { repo: "demo", caches: [] },
  };
  const setups = { inst: { repo: "demo", extra_volumes: ["tools:/t"] }, other: { repo: "demo" } };
  const before = structuredClone([services, setups]);
  const [svc, set] = applyCaches(services, setups, {}, CACHES, path.join(tmp, "ws"));

  assert.deepEqual(svc.a.extra_volumes, ["/var/cache/h:/h", "^werkmeister-turbo:/turbo-cache"]);
  assert.equal(
    svc.a.environment.TURBO_CACHE_DIR,
    "/mine",
    "the service's own env beats the cache's",
  );
  assert.deepEqual(svc.b.extra_volumes, ["^werkmeister-pnpm-store:/pnpm-store"]);
  assert.equal(svc.b.environment.npm_config_store_dir, "/pnpm-store");
  assert.equal(svc.c, services.c, "no caches: entry passes through");
  assert.deepEqual(set.inst.extra_volumes, [
    "tools:/t",
    "/var/cache/h:/h",
    "^werkmeister-pnpm-store:/pnpm-store",
    "^werkmeister-turbo:/turbo-cache",
  ]);
  assert.equal(set.other, setups.other);
  assert.deepEqual([services, setups], before);
});

/** Compose renders `environment:` as `KEY=value` lines. */
const envOf = (svc) =>
  Object.fromEntries(svc.environment.map((e) => e.split(/=(.*)/s).slice(0, 2)));

/** Render *feature*'s compose through the real template for a workspace at *ws*. */
function renderCompose(feature, ws) {
  const prev = process.env.SANDBOX_ROOT;
  process.env.SANDBOX_ROOT = CLI_ROOT;
  try {
    return YAML.parse(
      fs.readFileSync(generateFeatureCompose(feature, 1, ["backend"], null, ws), "utf8"),
    );
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_ROOT;
    else process.env.SANDBOX_ROOT = prev;
  }
}

const REGISTRY = (caches) => `services:
  backend:
    type: api
    repo: demo-repo
    port_offset: 2
    setup_service: demo-install
    node_modules_volume: node-modules
setup_services:
  demo-install:
    repo: demo-repo
    image: node:22
    command: "install"
    node_modules_volume: node-modules
${YAML.stringify({ caches })}`;

test("a new tool is a registry entry: yarn and cargo caches reach the compose with no code change", async () => {
  const ws = path.join(tmp, "ws");
  dirWith("ws/demo-repo", "yarn.lock", "Cargo.lock");
  const caches = {
    "yarn-cache": {
      path: "/yarn-cache",
      env: { YARN_CACHE_FOLDER: "/yarn-cache" },
      detect: ["yarn.lock"],
    },
    cargo: {
      path: "/cargo-home",
      volume: "cargo-home",
      env: { CARGO_HOME: "/cargo-home" },
      detect: ["Cargo.lock"],
    },
    unused: { path: "/u", detect: ["go.sum"] },
  };
  await withSandboxHome(
    async () => {
      const doc = renderCompose("alpha", ws);
      assert.deepEqual(doc.volumes["werkmeister-yarn-cache"], {
        name: "werkmeister-yarn-cache",
        external: true,
      });
      assert.deepEqual(doc.volumes["cargo-home"], { name: "cargo-home", external: true });
      assert.equal(doc.volumes["werkmeister-unused"], undefined, "an undetected cache is not declared");
      for (const svc of ["backend", "demo-install"]) {
        const s = doc.services[svc];
        assert.ok(s.volumes.includes("werkmeister-yarn-cache:/yarn-cache"), svc);
        assert.ok(s.volumes.includes("cargo-home:/cargo-home"), svc);
        assert.equal(envOf(s).YARN_CACHE_FOLDER, "/yarn-cache", svc);
        assert.equal(envOf(s).CARGO_HOME, "/cargo-home", svc);
      }
    },
    { services: REGISTRY(caches) },
  );
});

test("the built-in pnpm-store and turbo caches attach by lockfile alone", async () => {
  const ws = path.join(tmp, "ws");
  dirWith("ws/demo-repo", "pnpm-lock.yaml", "turbo.json");
  await withSandboxHome(
    async () => {
      const doc = renderCompose("alpha", ws);
      assert.deepEqual(doc.volumes["werkmeister-pnpm-store"], {
        name: "werkmeister-pnpm-store",
        external: true,
      });
      assert.deepEqual(doc.volumes["werkmeister-turbo"], { name: "werkmeister-turbo", external: true });
      for (const svc of ["backend", "demo-install"]) {
        const s = doc.services[svc];
        assert.ok(s.volumes.includes("werkmeister-pnpm-store:/pnpm-store"), svc);
        assert.ok(s.volumes.includes("werkmeister-turbo:/turbo-cache"), svc);
        assert.equal(envOf(s).npm_config_store_dir, "/pnpm-store", svc);
        assert.equal(envOf(s).TURBO_CACHE_DIR, "/turbo-cache", svc);
      }
    },
    { services: REGISTRY(REGISTRY_DEFAULTS.caches) },
  );
});

test("cacheSnapshots: volume rows from docker df, a missing volume, a host dir sized from disk", async () => {
  const hostDir = dirWith("hostcache");
  fs.writeFileSync(path.join(hostDir, "a"), "12345");
  dirWith("hostcache/sub");
  fs.writeFileSync(path.join(hostDir, "sub", "b"), "678");
  const caches = { a: { path: "/a" }, b: { path: "/b" }, h: { path: "/h", host: hostDir } };
  const usage = new Map([
    ["werkmeister-a", { size: 2048, createdAt: "2026-10-01T00:00:00Z" }],
    // SW-93: the pre-rename default, left over on a machine that had it.
    ["sandbox-a", { size: 4096, createdAt: "2026-09-01T00:00:00Z" }],
  ]);
  const rows = await cacheSnapshots(caches, usage);
  assert.deepEqual(rows[0], {
    name: "a",
    kind: "volume",
    source: "werkmeister-a",
    exists: true,
    size_bytes: 2048,
    created_at: "2026-10-01T00:00:00Z",
  });
  assert.deepEqual(rows[1], {
    name: "a",
    kind: "volume",
    source: "sandbox-a",
    exists: true,
    size_bytes: 4096,
    created_at: "2026-09-01T00:00:00Z",
  });
  assert.deepEqual(rows[2], {
    name: "b",
    kind: "volume",
    source: "werkmeister-b",
    exists: false,
    size_bytes: null,
    created_at: null,
  });
  assert.equal(rows[3].kind, "host");
  assert.equal(rows[3].size_bytes, 8);
  assert.equal(rows.length, 4);
});

/** pruneCaches with every Docker read faked; `ran` collects each `docker run` argv. */
function fakeDeps(caches, { exists = true, busy = [], stdout = "", leftover = [] } = {}) {
  const ran = [];
  return {
    ran,
    deps: {
      caches,
      snapshots: async (c) =>
        Object.keys(c)
          .sort()
          .flatMap((name) =>
            [
              c[name].host ?? `werkmeister-${name}`,
              ...(leftover.includes(name) ? [`sandbox-${name}`] : []),
            ].map((source) => ({
              name,
              kind: c[name].host ? "host" : "volume",
              source,
              exists,
              size_bytes: 1000,
              created_at: null,
            })),
          ),
      busy: async () => busy,
      run: (argv) => {
        ran.push(argv);
        return { status: 0, stdout, stderr: "" };
      },
    },
  };
}

const RULES = {
  turbo: { path: "/turbo-cache", max_age: "14d" },
  cargo: {
    path: "/cargo",
    prune: "cargo cache -a",
    env: { CARGO_HOME: "/cargo" },
    image: "rust:1",
  },
  "pnpm-store": { path: "/pnpm-store" },
};

test("pruneCaches: max_age by -mmin, prune with the cache env, no rule skipped", async () => {
  const { ran, deps } = fakeDeps(RULES);
  const results = await pruneCaches({}, deps);
  assert.deepEqual(
    results.map((r) => [r.name, r.action, r.ok]),
    [
      ["cargo", "prune", true],
      ["pnpm-store", "skipped", true],
      ["turbo", "max_age", true],
    ],
  );
  assert.match(results[1].detail, /no prune rule; use --reset/);
  assert.deepEqual(ran[0], [
    "docker",
    "run",
    "--rm",
    "-v",
    "werkmeister-cargo:/cargo",
    "-e",
    "CARGO_HOME=/cargo",
    "rust:1",
    "sh",
    "-c",
    "cargo cache -a",
  ]);
  assert.deepEqual(ran[1].slice(0, 6), [
    "docker",
    "run",
    "--rm",
    "-v",
    "werkmeister-turbo:/turbo-cache",
    "node:22",
  ]);
  assert.equal(
    ran[1].at(-1),
    "find '/turbo-cache' -mindepth 1 -type f -mmin +20160 -delete && find '/turbo-cache' -mindepth 1 -type d -empty -delete",
  );
});

test("pruneCaches: a leftover sandbox-<key> volume (SW-93) is pruned too, under its own name", async () => {
  const { ran, deps } = fakeDeps(RULES, { leftover: ["turbo"] });
  const results = await pruneCaches({ name: "turbo" }, deps);
  assert.deepEqual(
    results.map((r) => [r.name, r.action, r.ok]),
    [
      ["turbo", "max_age", true],
      ["turbo (sandbox-turbo)", "max_age", true],
    ],
  );
  assert.deepEqual(
    ran.map((argv) => argv[4]),
    ["werkmeister-turbo:/turbo-cache", "sandbox-turbo:/turbo-cache"],
  );
});

test("pruneCaches: --reset empties with find, never removes a volume", async () => {
  const { ran, deps } = fakeDeps(RULES);
  const results = await pruneCaches({ name: "pnpm-store", reset: true }, deps);
  assert.deepEqual(
    results.map((r) => [r.name, r.action, r.ok]),
    [["pnpm-store", "reset", true]],
  );
  assert.equal(ran.length, 1);
  assert.equal(ran[0].at(-1), "find '/pnpm-store' -mindepth 1 -delete");
  assert.ok(!ran.flat().includes("rm"), "no docker volume rm");
});

test("pruneCaches: a busy cache is skipped unless --force; a missing one is never touched", async () => {
  let f = fakeDeps(RULES, { busy: ["alpha-cli"] });
  let results = await pruneCaches({ name: "turbo" }, f.deps);
  assert.match(results[0].detail, /in use by alpha-cli/);
  assert.equal(f.ran.length, 0);
  results = await pruneCaches({ name: "turbo", force: true }, f.deps);
  assert.equal(results[0].action, "max_age");
  assert.equal(f.ran.length, 1);

  results = await pruneCaches({ name: "turbo", dryRun: true }, f.deps);
  assert.match(results[0].detail, /would delete .* older than 14d \(in use by alpha-cli\)/);
  assert.ok(!f.ran.at(-1).at(-1).includes("-delete"), "a busy dry run still deletes nothing");

  f = fakeDeps(RULES, { exists: false });
  results = await pruneCaches({ reset: true }, f.deps);
  assert.ok(results.every((r) => r.action === "skipped" && r.detail === "not created"));
  assert.equal(f.ran.length, 0, "docker run -v would create the volume");
});

test("pruneCaches: --dry-run counts max_age files and runs nothing destructive; an unknown name fails", async () => {
  const { ran, deps } = fakeDeps(RULES, { stdout: "7\n" });
  const results = await pruneCaches({ dryRun: true }, deps);
  assert.equal(ran.length, 1, "only the max_age count runs");
  assert.ok(!ran[0].at(-1).includes("-delete"));
  assert.match(ran[0].at(-1), /\| wc -l$/);
  assert.match(
    results.find((r) => r.name === "turbo").detail,
    /would delete 7 file\(s\) older than 14d/,
  );
  assert.match(results.find((r) => r.name === "cargo").detail, /would run: cargo cache -a/);
  const reset = await pruneCaches({ dryRun: true, reset: true, name: "pnpm-store" }, deps);
  assert.match(reset[0].detail, /would empty 1000 bytes/);

  const unknown = await pruneCaches({ name: "nope" }, deps);
  assert.equal(unknown[0].ok, false);
  assert.match(unknown[0].detail, /unknown cache \(known: cargo, pnpm-store, turbo\)/);
});
