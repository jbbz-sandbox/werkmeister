// Raw manifests, `helm template` output and `kubectl kustomize` output all go
// through the same k8s reader.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  detectHelm,
  detectK8s,
  detectKustomize,
  stdoutRunner,
} from "./dist/fragment_detect/index.js";
import { ctxFor, fixture } from "./fragment-detect-helpers.mjs";

const DEMO_BACKEND = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
spec:
  selector: { matchLabels: { app: backend } }
  template:
    metadata:
      labels: { app: backend }
    spec:
      containers:
        - name: backend
          image: backend:local
          ports:
            - containerPort: 3000
          readinessProbe:
            httpGet: { path: /health, port: 3000 }
          resources:
            limits: { memory: 1Gi }
            requests: { memory: 256Mi }
          env:
            - name: DATABASE_URL
              value: postgres://postgres:postgres@postgres:5432/postgres
            - name: API_KEY
              valueFrom: { secretKeyRef: { name: api, key: key } }
---
apiVersion: v1
kind: Service
metadata:
  name: backend
spec:
  selector: { app: backend }
  ports:
    - port: 80
      name: http
      targetPort: 3000
`;

test("a raw Deployment + Service file", () => {
  const ctx = ctxFor(fixture({ "apps/backend/k8s.yaml": DEMO_BACKEND }));
  const [f] = detectK8s(ctx);
  assert.equal(f.name, "backend");
  assert.equal(f.dir, "apps/backend");
  assert.equal(f.image, "backend:local");
  const v = (k) => f.fields[k]?.value;
  assert.equal(v("internal_port"), 3000);
  assert.equal(v("health_endpoint"), "/health");
  assert.equal(v("k8s_deployment"), "backend");
  assert.equal(v("k8s_namespace"), "default");
  assert.equal(v("k8s_pod_prefix"), "backend");
  assert.equal(v("k8s_port"), 80);
  assert.equal(v("k8s_port_name"), "http");
  assert.equal(v("memory_limit"), "1G");
  assert.equal(v("memory_reservation"), "256M");
  assert.deepEqual(v("environment"), {
    DATABASE_URL: "postgres://postgres:postgres@postgres:5432/postgres",
  });
  assert.deepEqual(v("secrets"), ["API_KEY"]);
  assert.match(f.fields.internal_port.source, /apps\/backend\/k8s\.yaml → containerPort/);
});

test("a Service in a different file still matches its Deployment; an Ingress marks it routed", () => {
  const [deploy, svc] = DEMO_BACKEND.split("---");
  const ingress = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: web }
spec:
  rules:
    - http:
        paths:
          - path: /
            backend: { service: { name: backend, port: { number: 80 } } }
`;
  const ctx = ctxFor(
    fixture({
      "deploy/deployment.yaml": deploy,
      "deploy/service.yaml": svc,
      "deploy/ingress.yaml": ingress,
    }),
  );
  const [f] = detectK8s(ctx);
  assert.equal(f.fields.k8s_port.value, 80);
  assert.deepEqual(f.fields.feature_router.value, {});
});

test("a bare Deployment, a List, and YAML that isn't k8s", () => {
  const bare =
    "kind: Deployment\nmetadata: { name: lone }\nspec: { template: { spec: { containers: [ { name: c, image: x } ] } } }\n";
  const list =
    "kind: List\nitems:\n  - kind: StatefulSet\n    metadata: { name: db, namespace: data }\n    spec: { template: { spec: { containers: [ { name: c, image: postgres:16 } ] } } }\n";
  const ctx = ctxFor(
    fixture({
      "a.yaml": bare,
      "b.yaml": list,
      ".github/x.yml": "kind: Deployment",
      "ci.yml": "on: push\n",
    }),
  );
  const found = detectK8s(ctx);
  assert.deepEqual(
    found.map((f) => f.name),
    ["lone", "db"],
  );
  assert.equal(found[0].fields.internal_port, undefined);
  assert.equal(found[0].fields.health_endpoint, undefined);
  assert.equal(found[1].fields.k8s_namespace.value, "data");
  assert.equal(found[1].fields.k8s_deployment, undefined);
  assert.deepEqual(ctx.skipped, []);
});

test("a manifest that doesn't parse is skipped with its error", () => {
  const ctx = ctxFor(fixture({ "bad.yaml": "kind: Deployment\nmetadata: [\n" }));
  assert.deepEqual(detectK8s(ctx), []);
  assert.equal(ctx.skipped[0].item, "bad.yaml");
});

test("chart sources, values files and compose files are not read as raw manifests", () => {
  const ctx = ctxFor(
    fixture({
      "charts/webapp/Chart.yaml": "name: webapp\n",
      "charts/webapp/templates/deployment.yaml":
        "kind: Deployment\nmetadata: { name: {{ .Release.Name }} }\n",
      "charts/backend.values.yaml": "kind: Deployment\n",
      "docker-compose.yml": "kind: Deployment\n",
    }),
  );
  assert.deepEqual(detectK8s(ctx), []);
  assert.deepEqual(ctx.skipped, []);
});

test("helm: each <release>.values.yaml next to a chart is rendered and read", () => {
  const root = fixture({
    "charts/webapp/Chart.yaml": "name: webapp\n",
    "charts/webapp/values.yaml": "containerPort: 3000\n",
    "charts/backend.values.yaml": "image: backend:local\n",
  });
  const calls = [];
  const runner = (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "helm") return [0, DEMO_BACKEND];
    return [128, "not a git repo"];
  };
  const ctx = ctxFor(root, runner);
  const [f] = detectHelm(ctx);
  assert.deepEqual(
    calls.filter((c) => c[0] === "helm"),
    [
      [
        "helm",
        "template",
        "backend",
        path.join(root, "charts/webapp"),
        "-f",
        path.join(root, "charts/backend.values.yaml"),
      ],
    ],
  );
  assert.equal(f.name, "backend");
  assert.equal(f.dir, null);
  assert.match(
    f.fields.internal_port.source,
    /charts\/backend\.values\.yaml \(helm template\) → containerPort/,
  );
});

test("helm: a chart with no sibling values files renders once under its Chart.yaml name", () => {
  const root = fixture({ "deploy/chart/Chart.yaml": "name: shop\n" });
  const seen = [];
  const ctx = ctxFor(root, (cmd) => {
    if (cmd[0] !== "helm") return [128, ""];
    seen.push(cmd[2]);
    return [0, ""];
  });
  detectHelm(ctx);
  assert.deepEqual(seen, ["shop"]);
});

test("helm missing: one skipped entry and no findings", () => {
  const root = fixture({
    "charts/webapp/Chart.yaml": "name: webapp\n",
    "charts/a.values.yaml": "",
    "charts/b.values.yaml": "",
  });
  const ctx = ctxFor(root);
  assert.deepEqual(detectHelm(ctx), []);
  assert.deepEqual(ctx.skipped, [
    { item: "helm charts", reason: "helm is not installed — charts skipped" },
  ]);
});

test("helm render failure is skipped per values file", () => {
  const root = fixture({
    "charts/webapp/Chart.yaml": "name: webapp\n",
    "charts/a.values.yaml": "",
  });
  const ctx = ctxFor(root, (cmd) =>
    cmd[0] === "helm" ? [1, "Error: image is required\nmore"] : [128, ""],
  );
  assert.deepEqual(detectHelm(ctx), []);
  assert.deepEqual(ctx.skipped, [
    { item: "charts/a.values.yaml", reason: "helm template failed: Error: image is required" },
  ]);
});

test("kustomize: each kustomization dir is rendered with kubectl", () => {
  const root = fixture({ "deploy/overlays/dev/kustomization.yaml": "resources: []\n" });
  const ctx = ctxFor(root, (cmd) => (cmd[0] === "kubectl" ? [0, DEMO_BACKEND] : [128, ""]));
  const [f] = detectKustomize(ctx);
  assert.equal(f.name, "backend");
  assert.match(f.file, /deploy\/overlays\/dev\/kustomization\.yaml \(kubectl kustomize\)/);
});

test("real helm renders a real chart the same way (skipped without helm)", (t) => {
  if (stdoutRunner(["helm", "version"])[0] !== 0) return t.skip("helm not installed");
  const root = path.join(mkdtempSync(path.join(tmpdir(), "fd-helm-")), "repo");
  const write = (rel, body) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  write("charts/webapp/Chart.yaml", "apiVersion: v2\nname: webapp\nversion: 0.1.0\n");
  write("charts/webapp/values.yaml", "containerPort: 3000\nprobePath: /\n");
  write(
    "charts/webapp/templates/deployment.yaml",
    [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata: { name: {{ .Release.Name }} }",
      "spec:",
      "  selector: { matchLabels: { app: {{ .Release.Name }} } }",
      "  template:",
      "    metadata: { labels: { app: {{ .Release.Name }} } }",
      "    spec:",
      "      containers:",
      "        - name: app",
      "          image: {{ .Values.image }}",
      "          ports: [ { containerPort: {{ .Values.containerPort }} } ]",
      "          readinessProbe: { httpGet: { path: {{ .Values.probePath }}, port: {{ .Values.containerPort }} } }",
      "",
    ].join("\n"),
  );
  write("charts/api.values.yaml", "image: api:local\ncontainerPort: 4000\nprobePath: /health\n");
  const [f] = detectHelm(ctxFor(root, stdoutRunner));
  assert.equal(f.name, "api");
  assert.equal(f.fields.internal_port.value, 4000);
  assert.equal(f.fields.health_endpoint.value, "/health");
});

const KUSTOMIZE_REPO = {
  "k8s/base/kustomization.yaml": "resources: [deployment.yaml]\n",
  "k8s/base/deployment.yaml": DEMO_BACKEND,
  "k8s/overlays/dev/kustomization.yaml": "resources:\n  - ../../base\nnamespace: dev\n",
  "k8s/overlays/dev/patch.yaml": "kind: Deployment\nmetadata: { name: backend }\n",
  "deploy/other.yaml":
    "kind: Deployment\nmetadata: { name: other }\nspec: { template: { spec: { containers: [ { name: c, image: 'other:1' } ] } } }\n",
};

test("raw YAML under a kustomization dir is left to kustomize", () => {
  const ctx = ctxFor(fixture(KUSTOMIZE_REPO));
  assert.deepEqual(
    detectK8s(ctx).map((f) => f.name),
    ["other"],
  );
});

test("kustomize: a base another kustomization builds on is not rendered on its own", () => {
  const rendered = [];
  const root = fixture(KUSTOMIZE_REPO);
  const ctx = ctxFor(root, (cmd) => {
    if (cmd[0] !== "kubectl") return [128, ""];
    rendered.push(path.relative(root, cmd[2]));
    return [0, DEMO_BACKEND];
  });
  detectKustomize(ctx);
  assert.deepEqual(rendered, ["k8s/overlays/dev"]);
});
