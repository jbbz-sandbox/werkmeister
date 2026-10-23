// One value per field from a group's findings, in the spec's order (§3).

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveInfra, resolveService } from "./dist/fragment_detect/index.js";

const st = (value, source) => ({ value, source, confidence: "stated" });
const gu = (value, source) => ({ value, source, confidence: "guessed" });
const finding = (kind, fields, extra = {}) => ({
  kind,
  name: "api",
  dir: null,
  file: kind,
  fields,
  ...extra,
});

test("k8s port beats EXPOSE, and the disagreement is recorded", () => {
  const r = resolveService({
    name: "api",
    dir: "apps/api",
    findings: [
      finding("dockerfile", {
        internal_port: st(8080, "Dockerfile → EXPOSE"),
        image: st("node:22", "Dockerfile → FROM"),
      }),
      finding("k8s", { internal_port: st(3000, "k8s.yaml → containerPort") }),
    ],
  });
  assert.equal(r.fields.internal_port.value, 3000);
  assert.equal(r.fields.path.value, "apps/api");
  assert.deepEqual(r.conflicts, [
    {
      service: "api",
      key: "internal_port",
      chosen: st(3000, "k8s.yaml → containerPort"),
      also: [st(8080, "Dockerfile → EXPOSE")],
    },
  ]);
});

test("a stated value beats a guess without recording a conflict", () => {
  const r = resolveService({
    name: "api",
    dir: ".",
    findings: [
      finding("package", {
        command: st("exec npm run dev", "package.json"),
        image: gu("node:22-alpine", "no Dockerfile"),
      }),
      finding("dockerfile", { command: gu("node server.js", "CMD"), image: st("node:22", "FROM") }),
    ],
  });
  assert.equal(r.fields.command.value, "exec npm run dev");
  assert.equal(r.fields.image.value, "node:22");
  assert.deepEqual(r.conflicts, []);
});

test("environment merges per key, compose winning; only k8s-only keys are rewrite candidates", () => {
  const r = resolveService({
    name: "api",
    dir: "apps/api",
    findings: [
      finding("k8s", { environment: st({ DB: "postgres:5432", MODE: "prod" }, "k8s.yaml → env") }),
      finding("compose", { environment: st({ MODE: "dev" }, "compose → environment") }),
    ],
  });
  assert.deepEqual(r.fields.environment.value, { DB: "postgres:5432", MODE: "dev" });
  assert.deepEqual(r.k8sEnvKeys, ["DB"]);
});

test("fallbacks are guesses: port 3000, TCP-only health, type api", () => {
  const r = resolveService({ name: "x", dir: "x", findings: [finding("dockerfile", {})] });
  assert.deepEqual(r.fields.internal_port, gu(3000, "no port in any source — default 3000"));
  assert.equal(r.fields.health_endpoint.value, "");
  assert.equal(r.fields.health_endpoint.confidence, "guessed");
  assert.equal(r.fields.type.value, "api");
  assert.equal(r.fields.image.confidence, "guessed");
});

test("feature_router: an Ingress states it, type web guesses it, an api gets none", () => {
  const web = resolveService({
    name: "w",
    dir: "w",
    findings: [finding("package", { type: st("web", "next") })],
  });
  assert.deepEqual(web.fields.feature_router, gu({}, "type: web — routed through Caddy"));
  const ing = resolveService({
    name: "a",
    dir: "a",
    findings: [finding("k8s", { feature_router: st({}, "Ingress") })],
  });
  assert.equal(ing.fields.feature_router.confidence, "stated");
  const api = resolveService({
    name: "a",
    dir: "a",
    findings: [finding("package", { type: st("api", "express") })],
  });
  assert.equal(api.fields.feature_router, undefined);
});

test("infrastructure from k8s, and from compose alone", () => {
  const k8s = resolveInfra({
    name: "postgres",
    datastore: "postgres",
    findings: [
      finding("k8s", {
        internal_port: st(5432, "pg.yaml → containerPort"),
        k8s_namespace: st("default", "pg.yaml"),
        k8s_pod_prefix: st("postgres", "pg.yaml"),
      }),
    ],
  });
  assert.deepEqual(Object.fromEntries(Object.entries(k8s.fields).map(([k, v]) => [k, v.value])), {
    internal_port: 5432,
    k8s_namespace: "default",
    k8s_pod_prefix: "postgres",
    health_endpoint: "postgres",
  });
  const compose = resolveInfra({
    name: "cache",
    datastore: "redis",
    findings: [finding("compose", {})],
  });
  assert.equal(compose.fields.internal_port.value, 6379);
  assert.equal(compose.fields.k8s_pod_prefix.confidence, "guessed");
  assert.equal(compose.fields.health_endpoint.value, "redis");
});

test("infrastructure: k8s sources that disagree keep the first and report the rest", () => {
  const skipped = [];
  const r = resolveInfra(
    {
      name: "postgres",
      datastore: "postgres",
      findings: [
        finding(
          "k8s",
          {
            internal_port: st(5432, "a.yaml → containerPort"),
            k8s_namespace: st("dev", "a.yaml → metadata.namespace"),
          },
          { file: "a.yaml" },
        ),
        finding(
          "k8s",
          {
            internal_port: st(5433, "b.yaml → containerPort"),
            k8s_namespace: st("dev", "b.yaml → metadata.namespace"),
          },
          { file: "b.yaml" },
        ),
      ],
    },
    skipped,
  );
  assert.equal(r.fields.internal_port.value, 5432);
  assert.equal(r.fields.k8s_namespace.value, "dev");
  assert.deepEqual(skipped, [
    {
      item: "b.yaml",
      reason:
        "infrastructure postgres: internal_port 5433 disagrees with 5432 (a.yaml → containerPort), kept 5432",
    },
  ]);
});
