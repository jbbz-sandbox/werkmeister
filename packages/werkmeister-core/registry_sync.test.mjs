// The merge is what makes `werkmeister setup` repeatable: every repo's
// .werkmeister/services.yaml fragment lands in one generated registry, with the
// collisions that would silently break port allocation or detection failing
// loud instead. These tests pin the merge rules; the filesystem step
// (syncRegistry) is pinned in the second half of this file.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parse } from "yaml";
import {
  branchRegistry,
  discoverFragments,
  expandPlaceholders,
  GENERATED_MARKER,
  inheritedK8sContext,
  mergeRegistry,
  RegistryError,
  renderRegistry,
  syncRegistry,
} from "./dist/registry_sync.js";
import { REGISTRY_DEFAULTS } from "./dist/scaffold.js";

const PATHS = {
  home: "/home/dev",
  repos_root: "/home/dev/repos",
  workspaces_root: "/home/dev/features",
  werkmeister_home: "/home/dev/.werkmeister",
  local_domain: "local.example.test",
};

let root;
let repos;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "registry-"));
  repos = path.join(root, "repos");
  mkdirSync(repos);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeFragment(repo, text, dotDir = ".werkmeister") {
  const dir = path.join(repos, repo, dotDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "services.yaml"), text);
}

const frag = (repo, doc) => ({ repo, path: `/x/${repo}/.werkmeister/services.yaml`, doc });
const merge = (fragments, local = {}) =>
  mergeRegistry(fragments, { defaults: REGISTRY_DEFAULTS, local, paths: PATHS });

test("discoverFragments finds only <dir>/.werkmeister/services.yaml, sorted by repo", () => {
  writeFragment("b-repo", "services: {}\n");
  writeFragment("a-repo", "services: {}\n");
  mkdirSync(path.join(repos, "no-fragment"));
  writeFileSync(path.join(repos, "stray-file"), "");
  const found = discoverFragments(repos);
  assert.deepEqual(
    found.map((f) => f.repo),
    ["a-repo", "b-repo"],
  );
  assert.equal(found[0].path, path.join(repos, "a-repo", ".werkmeister", "services.yaml"));
});

test("discoverFragments skips a linked git worktree of a repo it already scans", () => {
  writeFragment("app", "services: {}\n");
  writeFragment("app-wt", "services: {}\n");
  writeFileSync(path.join(repos, "app-wt", ".git"), "gitdir: ../app/.git/worktrees/app-wt\n");
  assert.deepEqual(
    discoverFragments(repos).map((f) => f.repo),
    ["app"],
  );
});

test("discoverFragments returns [] for a repos_root that does not exist", () => {
  assert.deepEqual(discoverFragments(path.join(root, "nope")), []);
});

test("discoverFragments names the file on a YAML syntax error", () => {
  writeFragment("bad", "services: [unclosed\n");
  assert.throws(
    () => discoverFragments(repos),
    (e) =>
      e instanceof RegistryError &&
      e.message.includes(path.join("bad", ".werkmeister", "services.yaml")),
  );
});

test("expandPlaceholders touches only the five names, at any depth", () => {
  const out = expandPlaceholders(
    {
      a: "{{home}}/.cache",
      w: "{{werkmeister_home}}/locks:/locks",
      b: ["{{repos_root}}:{{repos_root}}"],
      c: { d: "{{ workspaces_root }}" },
      hosts: ".{{local_domain}}",
      keep: "${WERKMEISTER_MCP_TOKEN} {{other}} {service}",
      n: 3,
    },
    PATHS,
  );
  assert.deepEqual(out, {
    a: "/home/dev/.cache",
    w: "/home/dev/.werkmeister/locks:/locks",
    b: ["/home/dev/repos:/home/dev/repos"],
    c: { d: "/home/dev/features" },
    hosts: ".local.example.test",
    keep: "${WERKMEISTER_MCP_TOKEN} {{other}} {service}",
    n: 3,
  });
});

test("mergeRegistry merges a fragment's repo: block into repos.<repo>", () => {
  const out = merge([
    frag("app", {
      repo: { ship: "tag", release_tag: "v*" },
      services: { api: { path: "apps/api" } },
    }),
  ]);
  assert.deepEqual(out.repos.app, {
    services: ["api"],
    path_mappings: { "apps/api": "api" },
    ship: "tag",
    release_tag: "v*",
  });
  assert.throws(
    () => merge([frag("app", { repo: "tag" })]),
    (e) => e instanceof RegistryError && /`repo:` must be a map/.test(e.message),
  );
  assert.throws(
    () => merge([frag("app", { repos: {} })]),
    (e) => e instanceof RegistryError && /unexpected top-level key `repos`/.test(e.message),
  );
});

test("mergeRegistry layers defaults, fragments and derives repos", () => {
  const out = merge([
    frag("demo", {
      services: {
        backend: { path: "apps/backend", port_offset: 0 },
        frontend: { path: "apps/frontend", port_offset: 1 },
      },
      setup_services: { "demo-install": { image: "node:22" } },
      infrastructure: { redis: { k8s_forward_port: 9050 } },
    }),
    frag("tool", { services: { cli: { path: ".", port_offset: 2 } } }),
  ]);
  assert.deepEqual(Object.keys(out.archetypes), [
    "node-web",
    "node-service",
    "node-tool",
    "mcp-client",
  ]);
  assert.equal(out.services.backend.repo, "demo");
  assert.equal(out.setup_services["demo-install"].repo, "demo");
  assert.deepEqual(out.repos, {
    demo: {
      services: ["backend", "frontend"],
      path_mappings: { "apps/backend": "backend", "apps/frontend": "frontend" },
    },
    tool: { services: ["cli"], path_mappings: {} },
  });
});

test("mergeRegistry rejects a repo: that disagrees with the directory", () => {
  assert.throws(
    () => merge([frag("demo", { services: { backend: { repo: "other" } } })]),
    /backend.*repo: other.*demo/,
  );
});

test("mergeRegistry rejects unknown top-level keys but ignores x- keys", () => {
  assert.throws(() => merge([frag("demo", { repos: {} })]), /unexpected top-level key `repos`/);
  const out = merge([frag("demo", { "x-anchors": { a: 1 }, services: {} })]);
  assert.equal(out["x-anchors"], undefined);
});

test("mergeRegistry rejects a non-map section naming file and section", () => {
  assert.throws(
    () => merge([frag("demo", { services: ["backend"] })]),
    /demo.*services.*must be a map/,
  );
});

test("each collision names both owners", () => {
  const a = (doc) => frag("a", doc);
  const b = (doc) => frag("b", doc);
  assert.throws(
    () => merge([a({ services: { s: {} } }), b({ services: { s: {} } })]),
    /services\.s.*both a and b/,
  );
  assert.throws(
    () => merge([a({ setup_services: { i: {} } }), b({ setup_services: { i: {} } })]),
    /setup_services\.i.*both a and b/,
  );
  assert.throws(
    () => merge([a({ infrastructure: { r: {} } }), b({ infrastructure: { r: {} } })]),
    /infrastructure\.r.*both a and b/,
  );
  assert.throws(
    () =>
      merge([
        a({ services: { x: { port_offset: 3 } } }),
        b({ services: { y: { port_offset: 3 } } }),
      ]),
    /port_offset 3.*both a:x and b:y/,
  );
  assert.throws(
    () =>
      merge([
        a({ services: { x: { k8s_forward_port: 9052 } } }),
        b({ infrastructure: { y: { k8s_forward_port: 9052 } } }),
      ]),
    /k8s_forward_port 9052.*both a:x and b:y/,
  );
});

test("caches: built-ins merged, a fragment may add one but not redefine one, the overlay may", () => {
  const yarn = { path: "/yarn-cache", detect: ["yarn.lock"] };
  const out = merge([frag("demo", { caches: { "yarn-cache": yarn } })]);
  assert.deepEqual(Object.keys(out.caches).sort(), ["pnpm-store", "turbo", "yarn-cache"]);
  assert.deepEqual(out.caches["yarn-cache"], yarn);
  assert.throws(
    () => merge([frag("demo", { caches: { turbo: { path: "/t" } } })]),
    /caches\.turbo.*both werkmeister and demo/,
  );
  assert.throws(
    () =>
      merge([
        frag("a", { caches: { c: { path: "/c" } } }),
        frag("b", { caches: { c: { path: "/c" } } }),
      ]),
    /caches\.c.*both a and b/,
  );
  const local = merge([], { caches: { turbo: { max_age: "7d" } } });
  assert.equal(local.caches.turbo.max_age, "7d");
  assert.equal(local.caches.turbo.path, "/turbo-cache");
});

test("the local overlay wins and may add top-level keys", () => {
  const out = merge(
    [frag("demo", { services: { backend: { memory_limit: "256M", environment: { A: "1" } } } })],
    {
      k8s_context: "kind-dev",
      services: { backend: { memory_limit: "1G", environment: { B: "2" } } },
    },
  );
  assert.equal(out.k8s_context, "kind-dev");
  assert.equal(out.services.backend.memory_limit, "1G");
  assert.deepEqual(out.services.backend.environment, { A: "1", B: "2" });
  assert.equal(out.services.backend.repo, "demo");
});

test("renderRegistry emits the marker, sources and the fixed key order", () => {
  const merged = merge([frag("demo", { services: { backend: { path: "apps/backend" } } })], {
    k8s_context: "orbstack",
  });
  const text = renderRegistry(
    merged,
    ["/x/demo/.werkmeister/services.yaml"],
    "/home/dev/.werkmeister/services.local.yaml",
  );
  assert.ok(text.startsWith(GENERATED_MARKER + "\n"));
  assert.ok(text.includes("# Source: /x/demo/.werkmeister/services.yaml"));
  assert.ok(text.includes("# Machine overrides: /home/dev/.werkmeister/services.local.yaml"));
  assert.deepEqual(Object.keys(parse(text)), [
    "archetypes",
    "caches",
    "mcp_servers",
    "k8s_context",
    "services",
    "infrastructure",
    "setup_services",
    "repos",
  ]);
  assert.equal(parse(text).mcp_servers.context7.env.CONTEXT7_API_KEY, "${CONTEXT7_API_KEY:-}");
});

// --- syncRegistry: the step `werkmeister setup` and `werkmeister registry` run -------
// Config lives in a temp ~/.werkmeister via WERKMEISTER_CONFIG_FILE, the same seam the
// CLI's tests use, so servicesYamlPath() lands in the temp dir.
const ENV = ["WERKMEISTER_CONFIG_FILE", "WERKMEISTER_SERVICES_YAML", "WERKMEISTER_WORKSPACES_ROOT"];
let savedEnv;
let home;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  home = path.join(root, "w9r-home");
  mkdirSync(home);
  process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "config.yaml");
  writeFileSync(
    process.env.WERKMEISTER_CONFIG_FILE,
    `paths:\n  repos_root: ${repos}\n  workspaces_root: ${path.join(root, "features")}\n`,
  );
});
afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const registryPath = () => path.join(home, "services.yaml");

test("syncRegistry fails loud with nothing written when no fragment exists", () => {
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.label, "config services.yaml");
  assert.equal(step.ok, false);
  assert.match(step.detail, /no .werkmeister\/services\.yaml found under/);
  assert.match(step.detail, /werkmeister setup/);
  assert.equal(existsSync(registryPath()), false);
});

test("syncRegistry reports 'no fragments' rather than throwing for a missing repos_root", () => {
  const [step] = syncRegistry({ reposRoot: path.join(root, "absent") });
  assert.equal(step.ok, false);
  assert.match(step.detail, /no .werkmeister\/services\.yaml found/);
});

test("syncRegistry writes the merged registry with expanded placeholders", () => {
  writeFragment(
    "demo",
    "services:\n  backend:\n    path: apps/backend\n    extra_volumes:\n      - '{{home}}/.cache:{{home}}/.cache'\n" +
      "      - '{{werkmeister_home}}/locks:/locks'\n",
    ".werkmeister",
  );
  writeFileSync(path.join(home, "services.local.yaml"), "k8s_context: kind-dev\n");
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, true, step.detail);
  const doc = parse(readFileSync(registryPath(), "utf8"));
  assert.equal(doc.k8s_context, "kind-dev");
  assert.equal(doc.services.backend.repo, "demo");
  assert.equal(
    doc.services.backend.extra_volumes[0],
    `${os.homedir()}/.cache:${os.homedir()}/.cache`,
  );
  assert.equal(
    doc.services.backend.extra_volumes[1],
    `${home}/locks:/locks`,
    "the tool home, wherever it is",
  );
  assert.deepEqual(doc.repos.demo.path_mappings, { "apps/backend": "backend" });
});

test("syncRegistry treats an empty services.local.yaml as no overrides", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  writeFileSync(path.join(home, "services.local.yaml"), "");
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, true, step.detail);
});

test("syncRegistry turns a merge error into a failing step", () => {
  writeFragment("a", "services:\n  s: {}\n");
  writeFragment("b", "services:\n  s: {}\n");
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, false);
  assert.match(step.detail, /services\.s is defined by both a and b/);
  assert.equal(existsSync(registryPath()), false);
});

test("syncRegistry is idempotent and --check reports drift or a missing file", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  assert.equal(syncRegistry({ reposRoot: repos, checkOnly: true })[0].ok, false);
  assert.match(
    syncRegistry({ reposRoot: repos, checkOnly: true })[0].detail,
    /missing — would generate/,
  );
  syncRegistry({ reposRoot: repos });
  const second = syncRegistry({ reposRoot: repos })[0];
  assert.equal(second.ok, true);
  assert.match(second.detail, /up to date/);
  assert.equal(syncRegistry({ reposRoot: repos, checkOnly: true })[0].ok, true);
  writeFragment("demo", "services:\n  backend:\n    port_offset: 1\n");
  const drift = syncRegistry({ reposRoot: repos, checkOnly: true })[0];
  assert.equal(drift.ok, false);
  assert.match(drift.detail, /drift — would regenerate/);
  assert.equal(
    existsSync(registryPath()) && !readFileSync(registryPath(), "utf8").includes("port_offset"),
    true,
  );
});

test("syncRegistry backs up a hand-written registry once, never a generated one", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  writeFileSync(registryPath(), "services:\n  hand-edited: {}\n");
  const first = syncRegistry({ reposRoot: repos, now: () => 1_700_000_000_000 })[0];
  assert.match(first.detail, /backed up to .*services\.yaml\.bak-1700000000/);
  assert.equal(
    readFileSync(path.join(home, "services.yaml.bak-1700000000"), "utf8"),
    "services:\n  hand-edited: {}\n",
  );
  writeFragment("demo", "services:\n  backend:\n    port_offset: 1\n");
  const second = syncRegistry({ reposRoot: repos, now: () => 1_700_000_001_000 })[0];
  assert.doesNotMatch(second.detail, /backed up/);
  assert.deepEqual(
    readdirSync(home).filter((f) => f.startsWith("services.yaml.bak")),
    ["services.yaml.bak-1700000000"],
  );
});

test("generatedOnly leaves a hand-written registry alone and still refreshes a generated one (SW-196)", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  writeFileSync(registryPath(), "services:\n  hand-edited: {}\n");
  const [skipped] = syncRegistry({ reposRoot: repos, generatedOnly: true });
  assert.equal(skipped.ok, false);
  assert.match(skipped.detail, /services\.yaml is hand-written — left as is/);
  assert.equal(readFileSync(registryPath(), "utf8"), "services:\n  hand-edited: {}\n");
  assert.deepEqual(
    readdirSync(home).filter((f) => f !== "config.yaml"),
    ["services.yaml"],
    "no backup, no seeded services.local.yaml",
  );

  rmSync(registryPath());
  syncRegistry({ reposRoot: repos });
  writeFragment("demo", "services:\n  backend:\n    port_offset: 1\n");
  const [refreshed] = syncRegistry({ reposRoot: repos, generatedOnly: true });
  assert.match(refreshed.detail, /^generated /);
  assert.equal(parse(readFileSync(registryPath(), "utf8")).services.backend.port_offset, 1);
});

test("syncRegistry seeds services.local.yaml when absent so k8s_context is never dropped", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  const localPath = path.join(home, "services.local.yaml");
  assert.equal(existsSync(localPath), false);
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, true, step.detail);
  assert.match(step.detail, /seeded .*services\.local\.yaml/);
  assert.equal(parse(readFileSync(localPath, "utf8")).k8s_context, "orbstack");
  assert.equal(parse(readFileSync(registryPath(), "utf8")).k8s_context, "orbstack");
  // Re-running neither reseeds nor reports it again.
  writeFileSync(localPath, "k8s_context: kind-dev\n");
  const [again] = syncRegistry({ reposRoot: repos });
  assert.doesNotMatch(again.detail, /seeded/);
  assert.equal(parse(readFileSync(registryPath(), "utf8")).k8s_context, "kind-dev");
});

// --- Review fixes: the existing-developer upgrade path -----------------------

test("inheritedK8sContext reads a hand-written registry's k8s_context and ignores a generated one", () => {
  assert.equal(inheritedK8sContext(registryPath()), null);
  writeFileSync(registryPath(), "k8s_context: kind-dev\nservices: {}\n");
  assert.equal(inheritedK8sContext(registryPath()), "kind-dev");
  writeFileSync(registryPath(), GENERATED_MARKER + "\nk8s_context: kind-dev\n");
  assert.equal(inheritedK8sContext(registryPath()), null);
  writeFileSync(registryPath(), "services: [unclosed\n");
  assert.equal(inheritedK8sContext(registryPath()), null);
});

test("syncRegistry carries a hand-written registry's k8s_context into the seeded overlay", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  writeFileSync(registryPath(), "k8s_context: kind-dev\nservices:\n  backend:\n    repo: demo\n");
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, true, step.detail);
  assert.equal(
    parse(readFileSync(path.join(home, "services.local.yaml"), "utf8")).k8s_context,
    "kind-dev",
  );
  assert.equal(parse(readFileSync(registryPath(), "utf8")).k8s_context, "kind-dev");
});

test("syncRegistry names hand-written entries that no fragment carries when it backs the file up", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  writeFileSync(
    registryPath(),
    "services:\n  backend: {}\n  orphan-svc: {}\nsetup_services:\n  orphan-install: {}\ninfrastructure:\n  redis: {}\n",
  );
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, true, step.detail);
  assert.match(
    step.detail,
    /not in any fragment: services\.orphan-svc, setup_services\.orphan-install, infrastructure\.redis/,
  );
  assert.doesNotMatch(step.detail, /services\.backend/);
});

test("branchRegistry takes the gated repo's fragment from its worktree, the rest from repos_root, and writes nothing (SW-25)", () => {
  writeFragment(
    "app",
    "services:\n  api:\n    path: apps/api\n    test: npx turbo run test --filter=old-api\n",
  );
  writeFragment("other", "services:\n  web:\n    path: apps/web\n    test: npm test\n");
  const worktree = path.join(root, "features", "ws", "app");
  mkdirSync(path.join(worktree, ".werkmeister"), { recursive: true });
  writeFileSync(
    path.join(worktree, ".werkmeister", "services.yaml"),
    "services:\n  api:\n    path: apps/api\n    test: npx turbo run test --filter=new-api\n" +
      "  worker:\n    path: apps/worker\n",
  );
  writeFileSync(path.join(home, "services.local.yaml"), "services:\n  web:\n    test: local\n");
  const reg = branchRegistry("app", worktree, repos);
  assert.equal(reg.services.api.test, "npx turbo run test --filter=new-api");
  assert.equal(reg.services.api.repo, "app");
  assert.deepEqual(reg.repos.app.path_mappings, { "apps/api": "api", "apps/worker": "worker" });
  assert.equal(reg.services.web.test, "local", "the machine overlay still wins");
  assert.equal(existsSync(registryPath()), false, "the shared registry is not written");
});

test("branchRegistry reads a worktree's .werkmeister/ fragment (SW-92)", () => {
  writeFragment("app", "services:\n  api:\n    test: old\n");
  const worktree = path.join(root, "features", "ws", "app");
  mkdirSync(path.join(worktree, ".werkmeister"), { recursive: true });
  writeFileSync(
    path.join(worktree, ".werkmeister", "services.yaml"),
    "services:\n  api:\n    test: new\n",
  );
  assert.equal(branchRegistry("app", worktree, repos).services.api.test, "new");
});

test("branchRegistry is null for a worktree without a fragment", () => {
  writeFragment("app", "services:\n  api: {}\n");
  assert.equal(branchRegistry("app", path.join(root, "nowhere"), repos), null);
});

// --- SW-129: disabled_fragments in services.local.yaml ----------------------
// Fixture: `app` (web) stays on; `demo` (api, redis, demo-install) is the one switched off.
const localYaml = () => path.join(home, "services.local.yaml");
function writeAppAndDemo() {
  writeFragment("app", "services:\n  web:\n    path: apps/web\n");
  writeFragment(
    "demo",
    "services:\n  api:\n    path: apps/api\ninfrastructure:\n  redis:\n    image: redis\n" +
      "setup_services:\n  demo-install:\n    command: npm i\n",
  );
}

test("syncRegistry leaves a disabled fragment out, reports it, and keeps the key out of the registry (SW-129)", () => {
  writeAppAndDemo();
  writeFileSync(localYaml(), "k8s_context: kind-dev\ndisabled_fragments: [demo]\n");
  const steps = syncRegistry({ reposRoot: repos });
  assert.equal(steps[0].ok, true, steps[0].detail);
  assert.match(steps[0].detail, /from 1 fragment$/);
  const skip = steps.find((s) => s.label === "fragment demo");
  assert.equal(skip?.ok, true);
  assert.match(skip.detail, /disabled in .*services\.local\.yaml — skipped/);
  const text = readFileSync(registryPath(), "utf8");
  assert.match(text, /^# Disabled: .*\/demo\/\.werkmeister\/services\.yaml$/m);
  const doc = parse(text);
  assert.deepEqual(Object.keys(doc.services), ["web"]);
  assert.deepEqual(doc.infrastructure, {});
  assert.deepEqual(doc.setup_services, {});
  assert.deepEqual(Object.keys(doc.repos), ["app"]);
  assert.equal(doc.disabled_fragments, undefined);
  assert.equal(doc.k8s_context, "kind-dev");
});

test("syncRegistry --check treats a disabled fragment as expected, and re-enabling brings it back (SW-129)", () => {
  writeAppAndDemo();
  writeFileSync(localYaml(), "disabled_fragments: [demo]\n");
  syncRegistry({ reposRoot: repos });
  const check = syncRegistry({ reposRoot: repos, checkOnly: true });
  assert.equal(check[0].ok, true, check[0].detail);
  assert.match(check[0].detail, /up to date/);

  writeFileSync(localYaml(), "disabled_fragments: []\n");
  const drift = syncRegistry({ reposRoot: repos, checkOnly: true });
  assert.match(drift[0].detail, /drift/);
  assert.equal(drift.length, 1, "nothing skipped once re-enabled");
  syncRegistry({ reposRoot: repos });
  const text = readFileSync(registryPath(), "utf8");
  assert.doesNotMatch(text, /# Disabled:/);
  const doc = parse(text);
  assert.deepEqual(Object.keys(doc.services).sort(), ["api", "web"]);
  assert.deepEqual(Object.keys(doc.infrastructure), ["redis"]);
  assert.deepEqual(Object.keys(doc.setup_services), ["demo-install"]);
});

test("syncRegistry drops overlay entries that belong to a disabled repo and keeps the rest (SW-129)", () => {
  writeAppAndDemo();
  writeFileSync(
    localYaml(),
    "disabled_fragments: [demo]\nservices:\n  mq:\n    repo: demo\n    image: mq\n" +
      "  api:\n    memory_limit: 2G\n  web:\n    memory_limit: 1G\n" +
      "infrastructure:\n  redis:\n    memory_limit: 1G\nrepos:\n  demo:\n    ship: merge\n",
  );
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, true, step.detail);
  const doc = parse(readFileSync(registryPath(), "utf8"));
  assert.deepEqual(Object.keys(doc.services), ["web"]);
  assert.equal(doc.services.web.memory_limit, "1G");
  assert.deepEqual(doc.infrastructure, {});
  assert.deepEqual(Object.keys(doc.repos), ["app"]);
});

test("syncRegistry notes a disabled name with no fragment and changes nothing else (SW-129)", () => {
  writeAppAndDemo();
  writeFileSync(localYaml(), "k8s_context: x\n");
  syncRegistry({ reposRoot: repos });
  const before = readFileSync(registryPath(), "utf8");
  writeFileSync(localYaml(), "k8s_context: x\ndisabled_fragments: [nope]\n");
  const steps = syncRegistry({ reposRoot: repos });
  assert.match(steps[0].detail, /up to date/);
  const note = steps.find((s) => s.label === "fragment nope");
  assert.equal(note?.ok, true);
  assert.match(note.detail, /no fragment under/);
  assert.equal(readFileSync(registryPath(), "utf8"), before);
});

test("syncRegistry fails on a disabled_fragments that is not a list of names (SW-129)", () => {
  writeAppAndDemo();
  writeFileSync(localYaml(), "disabled_fragments: demo\n");
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, false);
  assert.match(step.detail, /disabled_fragments must be a list of repo names/);
});

test("branchRegistry honours disabled_fragments but never drops the gated repo (SW-129)", () => {
  writeAppAndDemo();
  writeFileSync(localYaml(), "disabled_fragments: [demo, app]\n");
  const worktree = path.join(root, "features", "ws", "demo");
  mkdirSync(path.join(worktree, ".werkmeister"), { recursive: true });
  writeFileSync(
    path.join(worktree, ".werkmeister", "services.yaml"),
    "services:\n  api:\n    path: apps/api\n",
  );
  const reg = branchRegistry("demo", worktree, repos);
  assert.deepEqual(Object.keys(reg.services), ["api"]);
  assert.equal(reg.disabled_fragments, undefined);
});
