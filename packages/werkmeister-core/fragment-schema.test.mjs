// The fragment schema's `repo:` block (ship detection, docs/workspace-lifecycle.md),
// compiled with the same Ajv options as fragment_detect/validate.ts.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { parse } from "yaml";

const Ajv = createRequire(import.meta.url)("ajv");
const schema = JSON.parse(
  fs.readFileSync(
    new URL("../../apps/cli/infra/schemas/services-fragment.schema.json", import.meta.url),
    "utf8",
  ),
);
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const fragment = parse(
  fs.readFileSync(new URL("../../.werkmeister/services.yaml", import.meta.url), "utf8"),
);
const { repo: _, ...withoutRepo } = fragment;

test("this repo's fragment, with and without its repo: block, is valid", () => {
  assert.ok(validate(fragment), JSON.stringify(validate.errors));
  assert.ok(validate(withoutRepo), JSON.stringify(validate.errors));
  assert.ok(validate({ ...withoutRepo, repo: { ship: "merge" } }));
});

test("repo: rejects ship: tag without release_tag, unknown keys and unknown ship values", () => {
  assert.equal(validate({ ...withoutRepo, repo: { ship: "tag" } }), false);
  assert.equal(validate({ ...withoutRepo, repo: { shipp: "tag" } }), false);
  assert.equal(validate({ ...withoutRepo, repo: { ship: "deploy" } }), false);
});

test("cpus: accepted on services, setup services and extra_services; zero and junk rejected", () => {
  const api = {
    path: "apps/api",
    type: "api",
    internal_port: 3000,
    port_offset: 0,
    health_endpoint: "/health",
  };
  const svc = (cpus) => ({
    services: { api: { ...api, cpus } },
    setup_services: { install: { command: "yarn", cpus } },
  });
  for (const ok of [0.5, 2, "1.0", "0.25"])
    assert.ok(validate(svc(ok)), `${ok}: ${JSON.stringify(validate.errors)}`);
  for (const bad of [0, -1, "0", "0.0", "1G", "fast"])
    assert.equal(validate(svc(bad)), false, `${bad}`);
  const extra = {
    services: { api: { ...api, extra_services: { redis: { image: "redis", cpus: 0.5 } } } },
  };
  assert.ok(validate(extra), JSON.stringify(validate.errors));
});

test("caches: a yarn and a cargo entry validate; malformed entries and service lists are rejected", () => {
  const caches = {
    "yarn-cache": {
      path: "/yarn-cache",
      env: { YARN_CACHE_FOLDER: "/yarn-cache" },
      detect: ["yarn.lock"],
      max_age: "30d",
    },
    cargo: {
      path: "/cargo-home",
      env: { CARGO_HOME: "/cargo-home" },
      detect: ["Cargo.lock"],
      prune: "cargo cache -a",
      image: "rust:1",
    },
    turbo: { path: "/turbo", host: "{{home}}/.sandbox/cache/turbo" },
  };
  assert.ok(validate({ ...withoutRepo, caches }), JSON.stringify(validate.errors));
  const [svc] = Object.keys(withoutRepo.services);
  const withCaches = (list) => ({
    ...withoutRepo,
    services: { ...withoutRepo.services, [svc]: { ...withoutRepo.services[svc], caches: list } },
  });
  assert.ok(validate(withCaches(["yarn-cache"])), JSON.stringify(validate.errors));
  assert.ok(validate(withCaches([])));
  assert.equal(validate(withCaches("yarn-cache")), false);
  for (const bad of [
    { path: "rel/path" },
    { env: {} },
    { path: "/c", volume: "v", host: "/h" },
    { path: "/c", max_age: "14d", prune: "x" },
    { path: "/c", max_age: "2w" },
    { path: "/c", volume: "^v" },
    { path: "/c", colour: "red" },
  ]) {
    assert.equal(validate({ ...withoutRepo, caches: { c: bad } }), false, JSON.stringify(bad));
  }
});
