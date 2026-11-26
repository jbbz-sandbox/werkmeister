// SW-34: compose.yml also carries the checked-out repos' other services behind the
// `on-demand` profile, so the PR gate can `up -d <svc>` one for a repo with no
// container running, while a plain `up` still starts only the workspace's services.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { loadServices } from "../dist/config.js";
import {
  GATE_COMPOSE_FILE,
  generateFeatureCompose,
  generateFeatureEnv,
  renderGateCompose,
  writeServiceSecretEnvs,
} from "../dist/generate.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

function render(local, { checkout = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-od-ws-"));
  if (checkout) fs.mkdirSync(path.join(ws, "demo-repo"));
  try {
    return withSandboxHome(async () => {
      const text = fs.readFileSync(generateFeatureCompose("f", 1, local, null, ws), "utf8");
      return { text, compose: YAML.parse(text) };
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("a checked-out repo's other services render behind the on-demand profile", async () => {
  const { text, compose } = await render(["backend"]);
  assert.deepEqual(Object.keys(compose.services).sort(), ["backend", "frontend"]);
  assert.equal(compose.services.backend.profiles, undefined);
  assert.deepEqual(compose.services.frontend.profiles, ["on-demand"]);
  assert.equal(compose.services.frontend.container_name, "f-frontend");
  assert.deepEqual(compose.services.backend.env_file, [".env", ".env.backend"]);
  assert.deepEqual(compose.services.frontend.env_file, [
    ".env",
    { path: ".env.frontend", required: false },
  ]);
  assert.match(text, /^# Local services: backend$/m);
  assert.match(text, /^# On-demand services \(the PR gate starts these\): frontend$/m);
});

test("a workspace with no services gets every repo service on demand", async () => {
  const { compose } = await render([]);
  for (const svc of ["backend", "frontend"])
    assert.deepEqual(compose.services[svc].profiles, ["on-demand"], svc);
});

test("a repo that is not checked out adds nothing", async () => {
  const { text, compose } = await render(["backend"], { checkout: false });
  assert.deepEqual(Object.keys(compose.services), ["backend"]);
  assert.doesNotMatch(text, /On-demand/);
});

test("renderGateCompose names only the services a branch's settings change (SW-118)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-gate-ws-"));
  fs.mkdirSync(path.join(ws, "demo-repo"));
  try {
    await withSandboxHome(async () => {
      generateFeatureCompose("f", 1, ["backend"], null, ws);
      const services = loadServices();
      assert.deepEqual(renderGateCompose("f", 1, ["backend"], services, ws), []);
      const backend = { ...services.backend, environment: { REDIS_URL: "redis://redis:6379" } };
      assert.deepEqual(renderGateCompose("f", 1, ["backend"], { ...services, backend }, ws), [
        "backend",
      ]);
      const gate = YAML.parse(fs.readFileSync(path.join(ws, GATE_COMPOSE_FILE), "utf8"));
      assert.ok(gate.services.backend.environment.includes("REDIS_URL=redis://redis:6379"));
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// SW-942: compose refuses a non-profiled service that depends_on a profiled one, so a local
// service's checked-out dependency renders and starts with it, and an on-demand service keeps
// its on-demand dependency, which `up -d <svc>` (the gate, `--service`) then starts.
const DEPENDS = `services:
  backend:
    type: api
    repo: demo-repo
    port_offset: 2
    k8s_forward_port: 9052
  frontend:
    type: web
    repo: demo-repo
    port_offset: 3
    depends_on: [backend]
  cluster-only:
    type: api
    port_offset: 4
`;

async function renderWith(services, local) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-od-ws-"));
  fs.mkdirSync(path.join(ws, "demo-repo"));
  try {
    return await withSandboxHome(
      async () => {
        const compose = YAML.parse(
          fs.readFileSync(generateFeatureCompose("f", 1, local, null, ws), "utf8"),
        );
        writeServiceSecretEnvs(ws, local, loadServices());
        generateFeatureEnv("f", 1, local, null, ws);
        const dotenv = fs.readFileSync(path.join(ws, ".env"), "utf8");
        const envFiles = fs.readdirSync(ws).filter((f) => f.startsWith(".env."));
        return { compose, envFiles, dotenv };
      },
      { services },
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("a local service's checked-out dependency is local too, in depends_on and with its env file (SW-942)", async () => {
  const { compose, envFiles, dotenv } = await renderWith(DEPENDS, ["frontend"]);
  assert.equal(compose.services.backend.profiles, undefined);
  assert.ok(compose.services.frontend.depends_on?.backend, "frontend lost its backend dependency");
  assert.deepEqual(compose.services.backend.env_file, [".env", ".env.backend"]);
  // .env points the dependency at its container, not at the k8s forward.
  assert.match(dotenv, /^BACKEND_URL=http:\/\/backend:3000$/m);
  assert.deepEqual(envFiles.sort(), [".env.backend", ".env.frontend"]);
});

test("an on-demand service keeps its on-demand dependency (SW-942)", async () => {
  const { compose } = await renderWith(DEPENDS, []);
  assert.deepEqual(compose.services.frontend.profiles, ["on-demand"]);
  assert.deepEqual(compose.services.backend.profiles, ["on-demand"]);
  assert.ok(compose.services.frontend.depends_on?.backend, "frontend lost its backend dependency");
});

test("a dependency with no checked-out repo stays out of compose (SW-942)", async () => {
  const services = DEPENDS.replace("depends_on: [backend]", "depends_on: [cluster-only]");
  const { compose } = await renderWith(services, ["frontend"]);
  assert.equal(compose.services["cluster-only"], undefined);
  assert.equal(compose.services.frontend.depends_on, undefined);
});

// SW-956: in an all-on-demand workspace the gate starts frontend and, through depends_on, backend's
// container; frontend read BACKEND_URL (shared .env) and its {backend} ref as the k8s forward.
async function gateStartEnv(workspaceYml = "") {
  const services = DEPENDS.replace(
    "depends_on: [backend]",
    'depends_on: [backend]\n    environment:\n      API: "http://{backend}/api"',
  );
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-od-ws-"));
  fs.mkdirSync(path.join(ws, "demo-repo"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), workspaceYml);
  try {
    return await withSandboxHome(
      async () => {
        const compose = YAML.parse(
          fs.readFileSync(generateFeatureCompose("f", 1, [], null, ws), "utf8"),
        );
        generateFeatureEnv("f", 1, [], null, ws);
        // What startService writes before the gate's `up -d frontend`.
        writeServiceSecretEnvs(ws, ["frontend"], loadServices());
        // Compose reads env_file in order, a later file winning; `environment:` beats both.
        const env = {};
        for (const f of compose.services.frontend.env_file) {
          const file = path.join(ws, typeof f === "string" ? f : f.path);
          if (!fs.existsSync(file)) continue;
          for (const line of fs.readFileSync(file, "utf8").split("\n")) {
            const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
            if (m) env[m[1]] = m[2];
          }
        }
        return { env, environment: compose.services.frontend.environment };
      },
      { services },
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("an on-demand service the gate starts reaches its on-demand dependency's container (SW-956)", async () => {
  const { env, environment } = await gateStartEnv();
  assert.equal(env.BACKEND_URL, "http://backend:3000");
  assert.equal(env.BACKEND_HOST, "backend");
  assert.ok(environment.includes("API=http://backend:3000/api"), environment);
});

test("a workspace's own env_vars still win over a dependency's container URL (SW-956)", async () => {
  const { env } = await gateStartEnv("env_vars:\n  BACKEND_URL: http://elsewhere:1\n");
  assert.equal(env.BACKEND_URL, "http://elsewhere:1");
  assert.equal(env.BACKEND_HOST, "backend");
});
