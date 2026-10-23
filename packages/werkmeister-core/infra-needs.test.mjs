// On 2026-10-18 a werkmeister-only `up` restarted the shared k8s-forwards
// container while Kubernetes was being taken down (SW-42). `needsCluster` is
// the one test that now decides whether `up` may touch it at all.

import assert from "node:assert/strict";
import { test } from "node:test";

import { needsCluster } from "./dist/config.js";

const registry = {
  cli: { type: "cli" },
  "werkmeister-core": { type: "library" },
  "werkmeister-vscode": { type: "extension" },
  "werkmeister-dashboard": { type: "web", feature_router: {} },
  backend: { type: "api", k8s_deployment: "backend" },
  worker: { type: "api", environment: { REDIS_URL: "redis://k8s-redis:9050" } },
  caller: { type: "api", environment: { API: "http://{backend}/graphql" } },
  dependent: { type: "web", depends_on: ["backend"] },
  shelly: { type: "cli", environment: { TOKEN: "${GITHUB_AUTH_TOKEN}" } },
};

test("a workspace with no local services needs nothing", () => {
  assert.equal(needsCluster([], registry), false);
});

test("werkmeister-only and routed-only workspaces don't need the cluster", () => {
  assert.equal(needsCluster(["cli", "werkmeister-core", "werkmeister-vscode"], registry), false);
  assert.equal(needsCluster(["werkmeister-dashboard"], registry), false);
});

test("a cluster workload needs it", () => {
  assert.equal(needsCluster(["cli", "backend"], registry), true);
});

test("an environment naming a forward alias needs it", () => {
  assert.equal(needsCluster(["worker"], registry), true);
});

test("a {svc} ref or depends_on to a non-local service needs it", () => {
  assert.equal(needsCluster(["caller"], { ...registry, backend: {} }), true);
  assert.equal(needsCluster(["dependent"], { ...registry, backend: {} }), true);
});

test("the same ref or dependency on a local service doesn't", () => {
  const local = { ...registry, backend: {} };
  assert.equal(needsCluster(["caller", "backend"], local), false);
  assert.equal(needsCluster(["dependent", "backend"], local), false);
});

test("a ${VAR} shell reference is not a service ref", () => {
  assert.equal(needsCluster(["shelly"], registry), false);
});

test("a service missing from the registry needs nothing", () => {
  assert.equal(needsCluster(["ghost"], registry), false);
});
