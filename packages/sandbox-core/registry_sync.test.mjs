// The merge is what makes `sandbox setup` repeatable: every repo's
// .sandbox/services.yaml fragment lands in one generated registry, with the
// collisions that would silently break port allocation or detection failing
// loud instead. These tests pin the merge rules; the filesystem step
// (syncRegistry) is pinned in the second half of this file.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  discoverFragments,
  expandPlaceholders,
  mergeRegistry,
  renderRegistry,
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
