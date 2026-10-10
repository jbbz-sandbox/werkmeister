// `validate:` resolves like `test:` (service beats archetype), and the context
// file says how to validate every service in the workspace, not only the routed ones.
import { test } from "node:test";
import assert from "node:assert/strict";

import { candidateServiceNames, serviceValidation, validationRows } from "./dist/archetypes.js";
import { buildSandboxContextMd } from "./dist/claude_md.js";
import { loadServices } from "./dist/config.js";
import { withSandboxHome } from "./fixtures.mjs";

const ARCHS = { tool: { validate: "run the tests", test: "npm test" } };

test("serviceValidation: own beats archetype, archetype is the default, none is null", () => {
  assert.equal(serviceValidation({ archetype: "tool", validate: "run the binary" }, ARCHS), "run the binary");
  assert.equal(serviceValidation({ archetype: "tool" }, ARCHS), "run the tests");
  assert.equal(serviceValidation({ archetype: "tool" }, { tool: {} }), null);
  assert.equal(serviceValidation(null, ARCHS), null);
});

test("candidateServiceNames: selected services win, repos are the fallback", () => {
  const repos = { r: { services: ["a", "b"] } };
  assert.deepEqual(candidateServiceNames(["r"], repos, ["c"]), ["c"]);
  assert.deepEqual(candidateServiceNames(["r"], repos, []), ["a", "b"]);
});

test("validationRows: validate text, URL fallback, unregistered fallback", () => {
  const svcs = {
    lib: { repo: "r", path: "p", archetype: "tool" },
    web: { repo: "r", path: "w" },
    bare: { repo: "r", path: "b" },
  };
  const rows = Object.fromEntries(
    validationRows(["lib", "web", "bare"], svcs, ARCHS, new Set(["web"])).map((r) => [r.service, r]),
  );
  assert.equal(rows.lib.validate, "run the tests");
  assert.equal(rows.lib.test, "npm test");
  assert.match(rows.web.validate, /URL health check/);
  assert.match(rows.bare.validate, /No validation guidance registered/);
});

const SERVICES = `services:
  core:
    type: library
    repo: demo
    path: packages/core
    port_offset: 1
    archetype: tool
  cli:
    type: cli
    repo: demo
    path: apps/cli
    port_offset: 2
    archetype: tool
    validate: run the built binary against a fixture workspace
  web:
    type: web
    repo: demo
    path: apps/web
    port_offset: 3
    archetype: tool
    feature_router: {}
  elsewhere:
    type: api
    repo: other
    path: apps/elsewhere
    port_offset: 4
    k8s_forward_port: 9052
    feature_router: {}
archetypes:
  tool:
    test: npm test
    validate: run the tests
`;

test("only non-URL services: how to validate, and none of the routing sections", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("t", 1, 11100, 11119, [], loadServices(), "", null, ["core", "cli"]);
      assert.match(out, /## How to validate/);
      assert.match(out, /\| `core` \| demo \| `packages\/core` \| `npm test` \| run the tests \|/);
      assert.match(out, /\| `cli` \| demo \| `apps\/cli` \| `npm test` \| run the built binary against a fixture workspace \|/);
      for (const absent of [/curl/, /X-Feature/, /Proxy Routing/, /__sandbox/, /Caddy/, /Container Lifecycle/, /Slot & Port Range/, /elsewhere/, /Quick Health Checks/]) {
        assert.doesNotMatch(out, absent);
      }
    },
    { services: SERVICES },
  );
});

test("a URL-addressed candidate brings back health checks and routing, scoped to it", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("t", 1, 11100, 11119, [], loadServices(), "", null, ["core", "web"]);
      assert.match(out, /\| `web` \| demo \| `apps\/web` \| `npm test` \| run the tests \|/);
      assert.match(out, /## Quick Health Checks/);
      assert.match(out, /web\.local\.sandbox\.com/);
      assert.doesNotMatch(out, /elsewhere\.local\.sandbox\.com\/"/, "health checks skip hosts outside the candidates");
      assert.match(out, /## Proxy Routing/);
      assert.doesNotMatch(out, /Container Lifecycle/, "nothing runs locally");
    },
    { services: SERVICES },
  );
});

test("a local non-URL service gets lifecycle but no direct curl", async () => {
  await withSandboxHome(
    async () => {
      const out = buildSandboxContextMd("t", 1, 11100, 11119, ["core"], loadServices());
      assert.match(out, /## Container Lifecycle/);
      assert.match(out, /docker ps/);
      assert.doesNotMatch(out, /curl/);
      assert.doesNotMatch(out, /Proxy Routing/);
    },
    { services: SERVICES },
  );
});
