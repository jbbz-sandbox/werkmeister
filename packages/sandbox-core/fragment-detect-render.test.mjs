import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import { planFragment, renderFragment } from "./dist/fragment_detect/index.js";
import { fixture, noTools } from "./fragment-detect-helpers.mjs";

const opts = (root) => ({
  reposRoot: path.dirname(root),
  runner: noTools,
  localPath: path.join(path.dirname(root), "no-local.yaml"),
  portsPerSlot: 20,
});

const DEMO = {
  "package.json": { workspaces: ["apps/*"] },
  "package-lock.json": "{}",
  "apps/backend/package.json": {
    name: "backend",
    scripts: { dev: "node server.js", test: "vitest run" },
    dependencies: { pg: "8" },
  },
  "apps/backend/Dockerfile": 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  "apps/backend/k8s.yaml": [
    "kind: Deployment",
    "metadata: { name: backend }",
    "spec:",
    "  template:",
    "    metadata: { labels: { app: backend } }",
    "    spec:",
    "      containers:",
    "        - name: backend",
    "          image: backend:local",
    "          ports: [ { containerPort: 3000 } ]",
    "          readinessProbe: { httpGet: { path: /health, port: 3000 } }",
    "          env:",
    "            - { name: DATABASE_URL, value: 'postgres://u:p@postgres:5432/db' }",
    "---",
    "kind: Service",
    "metadata: { name: backend }",
    "spec: { selector: { app: backend }, ports: [ { port: 80, name: http } ] }",
    "",
  ].join("\n"),
  "apps/frontend/package.json": {
    name: "frontend",
    scripts: { dev: "next dev" },
    dependencies: { next: "15" },
  },
  "apps/frontend/Dockerfile": "FROM node:22-alpine\nEXPOSE 3000\n",
  "charts/postgres.yaml":
    "kind: Deployment\nmetadata: { name: postgres }\nspec: { template: { spec: { containers: [ { name: pg, image: 'postgres:16', ports: [ { containerPort: 5432 } ] } ] } } }\n",
};

test("a new fragment: header, every section, guessed comments, the env rewrite", () => {
  const root = fixture(DEMO, "demo-services");
  const plan = planFragment(root, opts(root));
  const r = renderFragment(plan);
  assert.ok(r.yaml.startsWith("# Sandbox service-registry fragment for this repo."));
  const doc = parse(r.yaml);
  assert.deepEqual(Object.keys(doc), ["services", "infrastructure", "setup_services"]);
  assert.deepEqual(Object.keys(doc.services), ["backend", "frontend"]);
  const be = doc.services.backend;
  assert.equal(be.path, "apps/backend");
  assert.equal(be.internal_port, 3000);
  assert.equal(be.port_offset, 0);
  assert.equal(be.health_endpoint, "/health");
  assert.equal(be.image, "node:22-alpine");
  assert.equal(be.command, "cd apps/backend && exec npm run dev");
  assert.equal(be.setup_service, "demo-services-install");
  assert.equal(be.k8s_port, 80);
  assert.equal(be.environment.DATABASE_URL, "postgres://u:p@k8s-postgres:9050/db");
  assert.equal(doc.services.frontend.port_offset, 1);
  assert.deepEqual(doc.services.frontend.feature_router, {});
  assert.deepEqual(doc.infrastructure.postgres, {
    k8s_forward_port: 9050,
    internal_port: 5432,
    k8s_namespace: "default",
    k8s_pod_prefix: "postgres",
    health_endpoint: "postgres",
  });
  assert.deepEqual(doc.setup_services["demo-services-install"], {
    image: "node:22-alpine",
    command: "npm install",
    node_modules_volume: "node-modules",
  });
  assert.match(r.yaml, /type: api # guessed: no web, api or bin marker/);
  assert.match(r.yaml, /# guessed: compose environment|# guessed: k8s env; DATABASE_URL rewritten/);
  assert.ok(r.changed);
});

test("re-running after writing changes nothing", () => {
  const root = fixture(DEMO, "demo-services");
  const first = renderFragment(planFragment(root, opts(root)));
  mkdirSync(path.join(root, ".sandbox"), { recursive: true });
  writeFileSync(first.path, first.yaml);
  const second = renderFragment(planFragment(root, opts(root)));
  assert.equal(second.changed, false);
  assert.equal(second.yaml, first.yaml);
  assert.deepEqual(second.added, []);
});

/** Every original line survives, unmodified and in order. */
function assertKeptAllBytes(original, output) {
  const out = output.split("\n");
  let i = 0;
  for (const line of original.split("\n")) {
    while (i < out.length && out[i] !== line) i++;
    assert.ok(i < out.length, `original line lost or altered: ${JSON.stringify(line)}`);
    i++;
  }
}

test("gap-filling keeps anchors, flow sequences, comments and hand values byte for byte", () => {
  const existing = [
    "# hand-written",
    "x-shared:",
    "  env: &shared_env",
    '    HOME: "{{home}}"',
    "",
    "services:",
    "  backend:",
    "    path: apps/backend   # keep me",
    "    secrets: [API_KEY]",
    "    environment: *shared_env",
    "    port_offset: 7",
    "    setup_service: demo-install",
    "",
  ].join("\n");
  const root = fixture({ ...DEMO, ".sandbox/services.yaml": existing }, "demo-services");
  const plan = planFragment(root, opts(root));
  const r = renderFragment(plan);
  assertKeptAllBytes(existing, r.yaml);
  const doc = parse(r.yaml);
  assert.equal(doc.services.backend.port_offset, 7);
  assert.deepEqual(doc.services.backend.environment, { HOME: "{{home}}" });
  assert.equal(doc.services.backend.internal_port, 3000);
  assert.equal(doc.services.frontend.port_offset, 0);
  assert.equal(doc.services.frontend.setup_service, "demo-install");
  assert.deepEqual(Object.keys(doc.setup_services), ["demo-install"]);
  assert.ok(r.added.includes("services.backend.internal_port"));
  assert.ok(!r.added.some((a) => a === "services.backend.port_offset"));
});

test("an empty or comment-only fragment gets the sections appended after it", () => {
  for (const existing of ["", "# nothing yet\n"]) {
    const root = fixture({ ...DEMO, ".sandbox/services.yaml": existing }, "demo-services");
    const r = renderFragment(planFragment(root, opts(root)));
    assert.ok(r.yaml.startsWith(existing));
    assert.deepEqual(Object.keys(parse(r.yaml).services), ["backend", "frontend"]);
  }
});

test("a conflict is written as an also: comment", () => {
  const root = fixture(
    {
      "package.json": { name: "api", scripts: { start: "node ." }, dependencies: { express: "4" } },
      Dockerfile: "FROM node:22-alpine\nEXPOSE 8080\n",
      "k8s.yaml":
        "kind: Deployment\nmetadata: { name: api }\nspec: { template: { spec: { containers: [ { name: c, image: 'api:1', ports: [ { containerPort: 3000 } ] } ] } } }\n",
    },
    "api",
  );
  const r = renderFragment(planFragment(root, opts(root)));
  assert.match(r.yaml, /internal_port: 3000 # also: 8080 \(Dockerfile → EXPOSE\)/);
});

test(".env.example keys are listed on the path line, not declared", () => {
  const root = fixture(
    {
      "package.json": { name: "api", scripts: { dev: "x" } },
      ".env.example": "export CLERK_SECRET_KEY=\nANTHROPIC_API_KEY=sk-...\n# comment\n",
    },
    "api",
  );
  const r = renderFragment(planFragment(root, opts(root)));
  assert.match(
    r.yaml,
    /path: "?\."? # \.env\.example also lists: ANTHROPIC_API_KEY, CLERK_SECRET_KEY/,
  );
  assert.equal(parse(r.yaml).services.api.secrets, undefined);
});

test("compose depends_on on a datastore is dropped; on a sibling service it is kept", () => {
  const root = fixture(
    {
      "docker-compose.yml":
        "services:\n  api:\n    build: ./api\n    depends_on: [cache, web]\n  web:\n    build: ./web\n  cache:\n    image: redis:7\n",
      "api/Dockerfile": "FROM golang:1.23\n",
      "web/Dockerfile": "FROM node:22\n",
    },
    "shop",
  );
  const doc = parse(renderFragment(planFragment(root, opts(root))).yaml);
  assert.deepEqual(doc.services.api.depends_on, ["web"]);
  assert.ok(doc.infrastructure.cache);
});

test("no trailing newline: several edits at EOF keep the last original line intact", () => {
  const existing =
    "services:\n  backend:\n    path: apps/backend\n    port_offset: 7\n    notes: >-\n      x\n      y";
  const root = fixture({ ...DEMO, ".sandbox/services.yaml": existing }, "demo-services");
  const r = renderFragment(planFragment(root, opts(root)));
  assertKeptAllBytes(existing, r.yaml);
  assert.ok(r.yaml.startsWith(existing + "\n"));
  const doc = parse(r.yaml);
  assert.equal(doc.services.backend.notes, "x y");
  assert.equal(doc.services.backend.internal_port, 3000);
  assert.ok(doc.services.frontend);
});

test("a service the human renamed is matched by path: no duplicate, only missing keys, port_offset kept", () => {
  const existing = "services:\n  api-server:\n    path: apps/api\n    port_offset: 4\n";
  const root = fixture(
    {
      "docker-compose.yml":
        "services:\n  api:\n    build: ./apps/api\n  web:\n    build: ./apps/web\n    depends_on: [api]\n",
      "apps/api/Dockerfile": "FROM golang:1.23\nEXPOSE 8000\n",
      "apps/web/Dockerfile": "FROM node:22\n",
      ".sandbox/services.yaml": existing,
    },
    "shop",
  );
  const r = renderFragment(planFragment(root, opts(root)));
  assertKeptAllBytes(existing, r.yaml);
  const doc = parse(r.yaml);
  assert.deepEqual(Object.keys(doc.services), ["api-server", "web"]);
  assert.equal(doc.services["api-server"].port_offset, 4);
  assert.equal(doc.services["api-server"].internal_port, 8000);
  assert.ok(r.added.includes("services.api-server.internal_port"));
  assert.ok(
    !r.added.some((a) => a.startsWith("services.api.") || a === "services.api-server.port_offset"),
  );
  assert.deepEqual(doc.services.web.depends_on, ["api-server"]);
});

test("renamed infrastructure is matched by k8s_pod_prefix, and the tunnel uses its name", () => {
  const existing =
    "infrastructure:\n  pg:\n    k8s_pod_prefix: postgres\n    k8s_forward_port: 9055\n";
  const root = fixture(
    {
      "k8s/postgres.yaml":
        "kind: Deployment\nmetadata: { name: postgres }\nspec: { template: { spec: { containers: [ { name: pg, image: 'postgres:16', ports: [ { containerPort: 5432 } ] } ] } } }\n",
      "apps/api/Dockerfile": "FROM golang:1.23\n",
      "apps/api/k8s.yaml":
        "kind: Deployment\nmetadata: { name: api }\nspec: { template: { spec: { containers: [ { name: api, image: 'api:1', env: [ { name: DATABASE_URL, value: 'postgres://u@postgres:5432/db' } ] } ] } } }\n",
      ".sandbox/services.yaml": existing,
    },
    "shop",
  );
  const r = renderFragment(planFragment(root, opts(root)));
  assertKeptAllBytes(existing, r.yaml);
  const doc = parse(r.yaml);
  assert.deepEqual(Object.keys(doc.infrastructure), ["pg"]);
  assert.equal(doc.infrastructure.pg.k8s_forward_port, 9055);
  assert.equal(doc.infrastructure.pg.internal_port, 5432);
  assert.equal(doc.services.api.environment.DATABASE_URL, "postgres://u@k8s-pg:9055/db");
});

test("a section present but empty, null or flow-styled is left alone, and the skip is reported", () => {
  for (const existing of ["services: {}\n", "services:\n", "services: { other: { path: x } }\n"]) {
    const root = fixture({ ...DEMO, ".sandbox/services.yaml": existing }, "demo-services");
    const r = renderFragment(planFragment(root, opts(root)));
    assert.ok(r.yaml.startsWith(existing));
    assert.ok(!r.added.some((a) => a.startsWith("services.")));
    assert.deepEqual(r.skipped, [
      "services: is empty, null or flow-styled in the existing file, so backend, frontend were not added — add them by hand",
    ]);
  }
  const root = fixture(DEMO, "demo-services");
  assert.deepEqual(renderFragment(planFragment(root, opts(root))).skipped, []);
});
