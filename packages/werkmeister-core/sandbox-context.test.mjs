// sandbox-context.md is loaded on demand, but when it loads it should describe
// this workspace — not every host on the machine and a hardcoded infra table
// whose ports had already drifted from the registry.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSandboxContextMd } from "./dist/claude_md.js";
import { loadServices } from "./dist/config.js";
import { withSandboxHome } from "./fixtures.mjs";

const SERVICES = `services:
  frontend:
    type: web
    repo: demo-repo
    path: apps/frontend
    port_offset: 1
    test: npm test -w frontend
    feature_router: {}
  backend:
    type: api
    repo: demo-repo
    path: apps/backend
    port_offset: 2
    k8s_forward_port: 9052
    feature_router: {}
  dashboard:
    type: web
    repo: other
    port_offset: 3
    k8s_forward_port: 9060
    feature_router: {}
`;

test("health checks and the feature URL are scoped to the local services", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices(), "/");
      const curls = out.match(/curl -sk -b "X-Feature=test"[^\n]*/g) ?? [];
      assert.equal(curls.length, 1, curls.join("\n"));
      assert.match(curls[0], /frontend\.local\.werkmeister\.io/);
      assert.match(out, /\*\*Feature URL:\*\* https:\/\/frontend\.local\.werkmeister\.io\//);
      assert.match(
        out,
        /document\.cookie = "X-Feature=test; domain=\.local\.werkmeister\.io; path=\/; SameSite=Lax"/,
      );
      assert.match(out, /frontend\.local\.werkmeister\.io\/__werkmeister/);
      assert.match(
        out,
        /\| `frontend` \| local \| `apps\/frontend` \| `test-frontend` \| 11101 \|/,
      );
      assert.match(out, /\| `backend` \| k8s \| `apps\/backend` \| — \| — \|/);
      assert.match(out, /\| `dashboard` \| k8s \| `\.` \|/, "a service without path: renders '.'");
      assert.doesNotMatch(out, /## Infrastructure/);
      assert.match(
        out,
        /- `https:\/\/dashboard\.local\.werkmeister\.io`/,
        "the routed-host list stays machine-wide",
      );
    },
    { services: SERVICES },
  );
});

test("no test path means the feature URL is the host root", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("test", 1, 11100, 11119, ["frontend"], loadServices());
      assert.match(out, /\*\*Feature URL:\*\* https:\/\/frontend\.local\.werkmeister\.io\/\n/);
    },
    { services: SERVICES },
  );
});

test("each local service's test command runs in its container; none says so", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd(
        "test",
        1,
        11100,
        11119,
        ["frontend", "backend"],
        loadServices(),
        "",
        {},
      );
      assert.match(
        out,
        /^- `frontend`: `docker exec test-frontend sh -c 'npm test -w frontend'`$/m,
      );
      assert.match(
        out,
        /^- `backend`: no test command registered \(add `test:` to its registry entry\)$/m,
      );
    },
    { services: SERVICES },
  );
});

test("Container Lifecycle mentions auto-stop only when it is on (#231)", async () => {
  await withSandboxHome(
    async () => {
      const args = ["test", 1, 11100, 11119, ["frontend"], loadServices()];
      const on = buildSandboxContextMd(...args, "", null, ["frontend"], true);
      assert.match(on, /## Container Lifecycle[\s\S]*Auto-stop is on[\s\S]*sandbox stop --if-idle/);
      assert.doesNotMatch(buildSandboxContextMd(...args), /--if-idle/);
    },
    { services: SERVICES },
  );
});
