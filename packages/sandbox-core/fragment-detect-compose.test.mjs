// docker-compose → environment, depends_on, command, port and health path per service.
import { test } from "node:test";
import assert from "node:assert/strict";

import { containerPort, detectCompose } from "./dist/fragment_detect/index.js";
import { ctxFor, fixture } from "./fragment-detect-helpers.mjs";

const COMPOSE = `
services:
  api:
    build: ./apps/api
    command: ["npm", "run", "dev"]
    ports: ["8080:3000/tcp"]
    environment:
      - REDIS_URL=redis://redis:6379
      - EMPTY=
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"]
  web:
    build:
      context: apps/web
    expose: [5173]
    environment:
      API_URL: http://api:3000
      UNSET:
    depends_on: [api]
  redis:
    image: redis:7-alpine
    ports:
      - target: 6379
        published: 6379
`;

test("each compose service becomes a finding", () => {
  const ctx = ctxFor(fixture({ "docker-compose.yml": COMPOSE }));
  const found = detectCompose(ctx);
  assert.deepEqual(found.map((f) => [f.name, f.dir, f.image ?? null]), [
    ["api", "apps/api", null],
    ["web", "apps/web", null],
    ["redis", null, "redis:7-alpine"],
  ]);
  const [api, web, redis] = found;
  assert.equal(api.fields.command.value, "npm run dev");
  assert.equal(api.fields.internal_port.value, 3000);
  assert.deepEqual(api.fields.environment.value, { REDIS_URL: "redis://redis:6379", EMPTY: "" });
  assert.deepEqual(api.fields.depends_on.value, ["redis"]);
  assert.equal(api.fields.health_endpoint.value, "/healthz");
  assert.equal(web.fields.internal_port.value, 5173);
  assert.deepEqual(web.fields.environment.value, { API_URL: "http://api:3000" });
  assert.deepEqual(web.fields.depends_on.value, ["api"]);
  assert.equal(redis.fields.internal_port.value, 6379);
  assert.match(api.fields.environment.source, /docker-compose\.yml → services\.api\.environment/);
});

test("a root build context anchors to the repo root", () => {
  const ctx = ctxFor(fixture({ "compose.yaml": "services:\n  app:\n    build: .\n" }));
  assert.equal(detectCompose(ctx)[0].dir, ".");
});

test("port spec forms", () => {
  assert.equal(containerPort(3000), 3000);
  assert.equal(containerPort("3000"), 3000);
  assert.equal(containerPort("127.0.0.1:8080:3000"), 3000);
  assert.equal(containerPort("9000-9001:9000-9001"), 9000);
  assert.equal(containerPort({ target: 80 }), 80);
  assert.equal(containerPort("abc"), undefined);
});

test("an unparsable compose file is skipped, not thrown", () => {
  const ctx = ctxFor(fixture({ "docker-compose.yml": "services: [\n" }));
  assert.deepEqual(detectCompose(ctx), []);
  assert.equal(ctx.skipped.length, 1);
  assert.equal(ctx.skipped[0].item, "docker-compose.yml");
});

test("compose merge keys are resolved", () => {
  const ctx = ctxFor(fixture({
    "docker-compose.yml": `
x-common: &common
  environment:
    A: "1"

services:
  svc:
    <<: *common
    build: ./svc
`,
  }));
  const found = detectCompose(ctx);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].fields.environment.value, { A: "1" });
});
