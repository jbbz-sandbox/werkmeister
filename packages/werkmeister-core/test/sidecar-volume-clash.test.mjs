// SW-955: a bare extra_volumes name is one <feature>-<name> volume for every container naming it, so two
// services' postgres sidecars on `pgdata` shared one data dir. Generation now refuses that.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { generateFeatureCompose } from "../dist/generate.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const registry = (a, b) => `services:
  backend:
    type: api
    repo: demo-repo
    port_offset: 2
    extra_services:
      backend-db: { image: "postgres:16", extra_volumes: ["${a}:/var/lib/postgresql/data"] }
  frontend:
    type: web
    repo: demo-repo
    port_offset: 3
    extra_services:
      frontend-db: { image: "postgres:16", extra_volumes: ["${b}:/var/lib/postgresql/data"] }
`;

function render(services) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-vol-ws-"));
  fs.mkdirSync(path.join(ws, "demo-repo"));
  try {
    return withSandboxHome(
      async () =>
        YAML.parse(
          fs.readFileSync(
            generateFeatureCompose("f", 1, ["backend", "frontend"], null, ws),
            "utf8",
          ),
        ),
      { services },
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("two sidecars naming one data volume refuse generation, naming the volume and both sidecars", async () => {
  await assert.rejects(
    render(registry("pgdata", "pgdata")),
    /Named volume 'pgdata' is mounted by backend-db \(sidecar of backend\), frontend-db \(sidecar of frontend\)/,
  );
});

test("sidecars with their own volume names each get a distinct <feature>-<name> volume", async () => {
  const compose = await render(registry("backend-pgdata", "frontend-pgdata"));
  assert.deepEqual(compose.services["backend-db"].volumes, [
    "f-backend-pgdata:/var/lib/postgresql/data",
  ]);
  assert.deepEqual(compose.services["frontend-db"].volumes, [
    "f-frontend-pgdata:/var/lib/postgresql/data",
  ]);
});

// SW-1233: each sidecar is a `services:` key and a container_name, so a repeated name is a duplicate key.
const named = (a, b) => `services:
  backend:
    type: api
    repo: demo-repo
    port_offset: 2
    extra_services:
      ${a}: { image: "postgres:16", extra_volumes: ["backend-pgdata:/var/lib/postgresql/data"] }
  frontend:
    type: web
    repo: demo-repo
    port_offset: 3
    extra_services:
      ${b}: { image: "postgres:16", extra_volumes: ["frontend-pgdata:/var/lib/postgresql/data"] }
`;

test("two services' sidecars with one name refuse generation, naming both services", async () => {
  await assert.rejects(
    render(named("postgres", "postgres")),
    /Sidecar 'postgres' is declared by backend and frontend/,
  );
});

test("a sidecar named like a service refuses generation, naming both", async () => {
  await assert.rejects(
    render(named("backend-db", "backend")),
    /Sidecar 'backend' of frontend has the name of service backend/,
  );
});

test("a sidecar named like a rendered setup service refuses generation, naming both", async () => {
  const services = `${named("backend-db", "install").replace(
    "    port_offset: 2\n",
    "    port_offset: 2\n    setup_service: install\n",
  )}setup_services:
  install: { repo: demo-repo, command: "true" }
`;
  await assert.rejects(
    render(services),
    /Sidecar 'install' of frontend has the name of setup service install/,
  );
});
