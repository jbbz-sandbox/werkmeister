// The merge is what makes `sandbox setup` repeatable: every repo's
// .sandbox/services.yaml fragment lands in one generated registry, with the
// collisions that would silently break port allocation or detection failing
// loud instead. These tests pin the merge rules; the filesystem step
// (syncRegistry) is pinned in the second half of this file.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  discoverFragments,
  expandPlaceholders,
  mergeRegistry,
  renderRegistry,
  syncRegistry,
  inheritedK8sContext,
  GENERATED_MARKER,
  RegistryError,
} from "./dist/registry_sync.js";
import { REGISTRY_DEFAULTS } from "./dist/scaffold.js";

const PATHS = { home: "/home/dev", repos_root: "/home/dev/repos", workspaces_root: "/home/dev/features" };

let root;
let repos;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "registry-"));
  repos = path.join(root, "repos");
  mkdirSync(repos);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeFragment(repo, text) {
  const dir = path.join(repos, repo, ".sandbox");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "services.yaml"), text);
}

const frag = (repo, doc) => ({ repo, path: `/x/${repo}/.sandbox/services.yaml`, doc });
const merge = (fragments, local = {}) =>
  mergeRegistry(fragments, { defaults: REGISTRY_DEFAULTS, local, paths: PATHS });

test("discoverFragments finds only <dir>/.sandbox/services.yaml, sorted by repo", () => {
  writeFragment("b-repo", "services: {}\n");
  writeFragment("a-repo", "services: {}\n");
  mkdirSync(path.join(repos, "no-fragment"));
  writeFileSync(path.join(repos, "stray-file"), "");
  const found = discoverFragments(repos);
  assert.deepEqual(found.map((f) => f.repo), ["a-repo", "b-repo"]);
  assert.equal(found[0].path, path.join(repos, "a-repo", ".sandbox", "services.yaml"));
});

test("discoverFragments skips a linked git worktree of a repo it already scans", () => {
  writeFragment("app", "services: {}\n");
  writeFragment("app-wt", "services: {}\n");
  writeFileSync(path.join(repos, "app-wt", ".git"), "gitdir: ../app/.git/worktrees/app-wt\n");
  assert.deepEqual(discoverFragments(repos).map((f) => f.repo), ["app"]);
});

test("discoverFragments returns [] for a repos_root that does not exist", () => {
  assert.deepEqual(discoverFragments(path.join(root, "nope")), []);
});

test("discoverFragments names the file on a YAML syntax error", () => {
  writeFragment("bad", "services: [unclosed\n");
  assert.throws(() => discoverFragments(repos), (e) =>
    e instanceof RegistryError && e.message.includes(path.join("bad", ".sandbox", "services.yaml")));
});

test("expandPlaceholders touches only the three names, at any depth", () => {
  const out = expandPlaceholders(
    { a: "{{home}}/.sandbox", b: ["{{repos_root}}:{{repos_root}}"], c: { d: "{{ workspaces_root }}" },
      keep: "${SANDBOX_MCP_TOKEN} {{other}} {service}", n: 3 },
    PATHS,
  );
  assert.deepEqual(out, {
    a: "/home/dev/.sandbox", b: ["/home/dev/repos:/home/dev/repos"], c: { d: "/home/dev/features" },
    keep: "${SANDBOX_MCP_TOKEN} {{other}} {service}", n: 3,
  });
});

test("mergeRegistry layers defaults, fragments and derives repos", () => {
  const out = merge([
    frag("demo", { services: { backend: { path: "apps/backend", port_offset: 0 }, frontend: { path: "apps/frontend", port_offset: 1 } },
                   setup_services: { "demo-install": { image: "node:22" } },
                   infrastructure: { redis: { k8s_forward_port: 9050 } } }),
    frag("tool", { services: { cli: { path: ".", port_offset: 2 } } }),
  ]);
  assert.deepEqual(Object.keys(out.archetypes), ["node-web", "node-service", "node-tool", "mcp-client"]);
  assert.equal(out.services.backend.repo, "demo");
  assert.equal(out.setup_services["demo-install"].repo, "demo");
  assert.deepEqual(out.repos, {
    demo: { services: ["backend", "frontend"], path_mappings: { "apps/backend": "backend", "apps/frontend": "frontend" } },
    tool: { services: ["cli"], path_mappings: {} },
  });
});

test("mergeRegistry rejects a repo: that disagrees with the directory", () => {
  assert.throws(() => merge([frag("demo", { services: { backend: { repo: "other" } } })]),
    /backend.*repo: other.*demo/);
});

test("mergeRegistry rejects unknown top-level keys but ignores x- keys", () => {
  assert.throws(() => merge([frag("demo", { repos: {} })]), /unexpected top-level key `repos`/);
  const out = merge([frag("demo", { "x-anchors": { a: 1 }, services: {} })]);
  assert.equal(out["x-anchors"], undefined);
});

test("mergeRegistry rejects a non-map section naming file and section", () => {
  assert.throws(() => merge([frag("demo", { services: ["backend"] })]), /demo.*services.*must be a map/);
});

test("each collision names both owners", () => {
  const a = (doc) => frag("a", doc);
  const b = (doc) => frag("b", doc);
  assert.throws(() => merge([a({ services: { s: {} } }), b({ services: { s: {} } })]), /services\.s.*both a and b/);
  assert.throws(() => merge([a({ setup_services: { i: {} } }), b({ setup_services: { i: {} } })]), /setup_services\.i.*both a and b/);
  assert.throws(() => merge([a({ infrastructure: { r: {} } }), b({ infrastructure: { r: {} } })]), /infrastructure\.r.*both a and b/);
  assert.throws(() => merge([a({ services: { x: { port_offset: 3 } } }), b({ services: { y: { port_offset: 3 } } })]), /port_offset 3.*both a:x and b:y/);
  assert.throws(() => merge([a({ services: { x: { k8s_forward_port: 9052 } } }), b({ infrastructure: { y: { k8s_forward_port: 9052 } } })]), /k8s_forward_port 9052.*both a:x and b:y/);
});

test("the local overlay wins and may add top-level keys", () => {
  const out = merge(
    [frag("demo", { services: { backend: { memory_limit: "256M", environment: { A: "1" } } } })],
    { k8s_context: "kind-dev", services: { backend: { memory_limit: "1G", environment: { B: "2" } } } },
  );
  assert.equal(out.k8s_context, "kind-dev");
  assert.equal(out.services.backend.memory_limit, "1G");
  assert.deepEqual(out.services.backend.environment, { A: "1", B: "2" });
  assert.equal(out.services.backend.repo, "demo");
});

test("renderRegistry emits the marker, sources and the fixed key order", () => {
  const merged = merge([frag("demo", { services: { backend: { path: "apps/backend" } } })], { k8s_context: "orbstack" });
  const text = renderRegistry(merged, ["/x/demo/.sandbox/services.yaml"], "/home/dev/.sandbox/services.local.yaml");
  assert.ok(text.startsWith(GENERATED_MARKER + "\n"));
  assert.ok(text.includes("# Source: /x/demo/.sandbox/services.yaml"));
  assert.ok(text.includes("# Machine overrides: /home/dev/.sandbox/services.local.yaml"));
  assert.deepEqual(Object.keys(parse(text)),
    ["archetypes", "mcp_servers", "k8s_context", "services", "infrastructure", "setup_services", "repos"]);
  assert.equal(parse(text).mcp_servers.context7.env.CONTEXT7_API_KEY, "${CONTEXT7_API_KEY:-}");
});

// --- syncRegistry: the step `sandbox setup` and `sandbox registry` run -------
// Config lives in a temp ~/.sandbox via SANDBOX_CONFIG_FILE, the same seam the
// CLI's tests use, so servicesYamlPath() lands in the temp dir.
const ENV = ["SANDBOX_CONFIG_FILE", "SANDBOX_SERVICES_YAML", "SANDBOX_WORKSPACES_ROOT"];
let savedEnv;
let home;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  home = path.join(root, "sandbox-home");
  mkdirSync(home);
  process.env.SANDBOX_CONFIG_FILE = path.join(home, "config.yaml");
  writeFileSync(process.env.SANDBOX_CONFIG_FILE,
    `paths:\n  repos_root: ${repos}\n  workspaces_root: ${path.join(root, "features")}\n`);
});
afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

const registryPath = () => path.join(home, "services.yaml");

test("syncRegistry fails loud with nothing written when no fragment exists", () => {
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.label, "config services.yaml");
  assert.equal(step.ok, false);
  assert.match(step.detail, /no .sandbox\/services\.yaml found under/);
  assert.match(step.detail, /sandbox setup/);
  assert.equal(existsSync(registryPath()), false);
});

test("syncRegistry reports 'no fragments' rather than throwing for a missing repos_root", () => {
  const [step] = syncRegistry({ reposRoot: path.join(root, "absent") });
  assert.equal(step.ok, false);
  assert.match(step.detail, /no .sandbox\/services\.yaml found/);
});

test("syncRegistry writes the merged registry with expanded placeholders", () => {
  writeFragment("demo", "services:\n  backend:\n    path: apps/backend\n    extra_volumes:\n      - '{{home}}/.sandbox:{{home}}/.sandbox'\n");
  writeFileSync(path.join(home, "services.local.yaml"), "k8s_context: kind-dev\n");
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, true, step.detail);
  const doc = parse(readFileSync(registryPath(), "utf8"));
  assert.equal(doc.k8s_context, "kind-dev");
  assert.equal(doc.services.backend.repo, "demo");
  assert.equal(doc.services.backend.extra_volumes[0], `${os.homedir()}/.sandbox:${os.homedir()}/.sandbox`);
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
  assert.match(syncRegistry({ reposRoot: repos, checkOnly: true })[0].detail, /missing — would generate/);
  syncRegistry({ reposRoot: repos });
  const second = syncRegistry({ reposRoot: repos })[0];
  assert.equal(second.ok, true);
  assert.match(second.detail, /up to date/);
  assert.equal(syncRegistry({ reposRoot: repos, checkOnly: true })[0].ok, true);
  writeFragment("demo", "services:\n  backend:\n    port_offset: 1\n");
  const drift = syncRegistry({ reposRoot: repos, checkOnly: true })[0];
  assert.equal(drift.ok, false);
  assert.match(drift.detail, /drift — would regenerate/);
  assert.equal(existsSync(registryPath()) && !readFileSync(registryPath(), "utf8").includes("port_offset"), true);
});

test("syncRegistry backs up a hand-written registry once, never a generated one", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  writeFileSync(registryPath(), "services:\n  hand-edited: {}\n");
  const first = syncRegistry({ reposRoot: repos, now: () => 1_700_000_000_000 })[0];
  assert.match(first.detail, /backed up to .*services\.yaml\.bak-1700000000/);
  assert.equal(readFileSync(path.join(home, "services.yaml.bak-1700000000"), "utf8"), "services:\n  hand-edited: {}\n");
  writeFragment("demo", "services:\n  backend:\n    port_offset: 1\n");
  const second = syncRegistry({ reposRoot: repos, now: () => 1_700_000_001_000 })[0];
  assert.doesNotMatch(second.detail, /backed up/);
  assert.deepEqual(readdirSync(home).filter((f) => f.startsWith("services.yaml.bak")), ["services.yaml.bak-1700000000"]);
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
  assert.equal(parse(readFileSync(path.join(home, "services.local.yaml"), "utf8")).k8s_context, "kind-dev");
  assert.equal(parse(readFileSync(registryPath(), "utf8")).k8s_context, "kind-dev");
});

test("syncRegistry names hand-written entries that no fragment carries when it backs the file up", () => {
  writeFragment("demo", "services:\n  backend: {}\n");
  writeFileSync(registryPath(),
    "services:\n  backend: {}\n  orphan-svc: {}\nsetup_services:\n  orphan-install: {}\ninfrastructure:\n  redis: {}\n");
  const [step] = syncRegistry({ reposRoot: repos });
  assert.equal(step.ok, true, step.detail);
  assert.match(step.detail, /not in any fragment: services\.orphan-svc, setup_services\.orphan-install, infrastructure\.redis/);
  assert.doesNotMatch(step.detail, /services\.backend/);
});
