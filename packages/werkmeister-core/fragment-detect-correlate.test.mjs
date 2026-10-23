// Findings from every detector grouped into services, infrastructure and leftovers.

import assert from "node:assert/strict";
import { test } from "node:test";

import { correlate, imageRepoName } from "./dist/fragment_detect/index.js";

const f = (kind, name, dir, extra = {}) => ({
  kind,
  name,
  dir,
  file: `${dir ?? "x"}/${kind}`,
  fields: {},
  ...extra,
});
const pkg = (dir, runnable = true) => f("package", dir.split("/").pop(), dir, { runnable });

test("imageRepoName strips registry, org, tag and digest", () => {
  assert.equal(imageRepoName("ghcr.io/acme/backend:1.2@sha256:abc"), "backend");
  assert.equal(imageRepoName("postgres:16"), "postgres");
  assert.equal(imageRepoName("bitnami/redis"), "redis");
});

test("anchors are source dirs; the four matching rules in order", () => {
  const c = correlate(
    [
      pkg("apps/backend"),
      pkg("apps/frontend"),
      f("dockerfile", "worker", "services/worker"),
      f("k8s", "something-else", "apps/backend/deploy"), // rule 1: inside the anchor dir
      f("compose", "fe", "apps/frontend"), // rule 2: build context
      f("k8s", "worker", null), // rule 3: name
      f("k8s", "web", null, { image: "ghcr.io/acme/frontend:1" }), // rule 4: image
    ],
    "demo",
  );
  const byName = Object.fromEntries(c.services.map((s) => [s.name, s.findings.map((x) => x.name)]));
  assert.deepEqual(byName, {
    backend: ["backend", "something-else"],
    frontend: ["frontend", "fe", "web"],
    worker: ["worker", "worker"],
  });
});

test("a single-service repo anchors at . and is named after the repo; location rule doesn't apply to .", () => {
  const c = correlate(
    [pkg("."), f("k8s", "redis", "charts", { image: "redis:7" }), f("k8s", "shop", null)],
    "shop",
  );
  assert.deepEqual(
    c.services.map((s) => [s.name, s.dir, s.findings.length]),
    [["shop", ".", 2]],
  );
  assert.deepEqual(
    c.infrastructure.map((i) => [i.name, i.datastore]),
    [["redis", "redis"]],
  );
});

test("colliding basenames become <parent>-<basename>; a root parent uses the repo name", () => {
  const c = correlate([pkg("services/api"), pkg("tools/api"), pkg("api")], "acme");
  assert.deepEqual(c.services.map((s) => s.name).sort(), ["acme-api", "services-api", "tools-api"]);
});

test("datastores become infrastructure, merged across k8s and compose by name", () => {
  const c = correlate(
    [
      pkg("apps/api"),
      f("k8s", "redis", "apps/api/k8s", { image: "redis:7-alpine" }),
      f("compose", "redis", null, { image: "redis:7" }),
    ],
    "r",
  );
  assert.deepEqual(
    c.services[0].findings.map((x) => x.kind),
    ["package"],
  );
  assert.equal(c.infrastructure.length, 1);
  assert.equal(c.infrastructure[0].findings.length, 2);
});

test("an unmatched app Deployment is skipped and reported", () => {
  const c = correlate([pkg("apps/api"), f("k8s", "payments", null, { image: "payments:1" })], "r");
  assert.equal(c.unmatched.length, 1);
  assert.match(
    c.skipped[0].reason,
    /found Deployment payments — no source dir in this repo, skipped/,
  );
});

test("a library package with nothing else is skipped; a runnable one or one with deploy config is kept", () => {
  const c = correlate(
    [pkg("packages/utils", false), pkg("packages/ui", false), f("k8s", "ui", null)],
    "r",
  );
  assert.deepEqual(
    c.services.map((s) => s.name),
    ["ui"],
  );
  assert.deepEqual(c.skipped, [
    {
      item: "packages/utils",
      reason: "library package (no Dockerfile, deploy config or dev/start script), skipped",
    },
  ]);
});
