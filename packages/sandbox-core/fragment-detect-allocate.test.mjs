// Machine-wide port allocation and the in-cluster → tunnel env rewrite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AllocationError, allocateForwards, allocateOffsets, portsPerSlot, rewriteEnv, takenPorts,
} from "./dist/fragment_detect/index.js";

test("offsets fill the lowest gap, in sorted name order", () => {
  const got = allocateOffsets(["zeta", "alpha", "mid"], new Set([0, 1, 2, 3, 4, 5, 7, 8]), 20);
  assert.deepEqual([...got], [["alpha", 6], ["mid", 9], ["zeta", 10]]);
});

test("running out of offsets throws with the spec's message", () => {
  const taken = new Set(Array.from({ length: 20 }, (_, i) => i));
  assert.throws(() => allocateOffsets(["x"], taken, 20), (e) =>
    e instanceof AllocationError &&
    e.message === "port_offset exhausted: 20 offsets (ports.yaml ports_per_slot) are all used — raise ports_per_slot or free one");
});

test("forward ports start at 9050 and skip taken ones", () => {
  assert.deepEqual([...allocateForwards(["redis", "postgres"], new Set([9050, 9052]))], [["postgres", 9051], ["redis", 9053]]);
});

test("takenPorts reads other repos' fragments, the local overlay and the existing file — not this repo's own path", () => {
  const reposRoot = mkdtempSync(path.join(tmpdir(), "fd-alloc-"));
  const write = (rel, body) => {
    mkdirSync(path.dirname(path.join(reposRoot, rel)), { recursive: true });
    writeFileSync(path.join(reposRoot, rel), body);
  };
  write("other/.sandbox/services.yaml", "services:\n  a: { port_offset: 0, k8s_forward_port: 9052 }\ninfrastructure:\n  redis: { k8s_forward_port: 9050, internal_port: 6379 }\n");
  write("mine/.sandbox/services.yaml", "services:\n  stale: { port_offset: 5 }\n");
  write("local.yaml", "services:\n  b: { port_offset: 3 }\n");
  const taken = takenPorts(reposRoot, path.join(reposRoot, "mine/.sandbox/services.yaml"), path.join(reposRoot, "local.yaml"), { services: { kept: { port_offset: 1 } } });
  assert.deepEqual([...taken.offsets].sort(), [0, 1, 3]);
  assert.deepEqual([...taken.forwards].sort(), [9050, 9052]);
});

test("portsPerSlot reads ports.yaml and defaults to 20", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fd-ports-"));
  writeFileSync(path.join(dir, "ports.yaml"), "feature_slots:\n  ports_per_slot: 30\n");
  assert.equal(portsPerSlot(path.join(dir, "ports.yaml")), 30);
  assert.equal(portsPerSlot(path.join(dir, "missing.yaml")), 20);
});

test("rewriteEnv points an in-cluster datastore address at the tunnel", () => {
  const env = {
    DATABASE_URL: "postgres://postgres:postgres@postgres:5432/postgres",
    OTHER: "my-postgres:5432",
    FROM_COMPOSE: "postgres:5432",
  };
  const r = rewriteEnv(env, ["DATABASE_URL", "OTHER"], [{ name: "postgres", port: 5432, forward: 9051 }]);
  assert.equal(r.env.DATABASE_URL, "postgres://postgres:postgres@k8s-postgres:9051/postgres");
  assert.equal(r.env.OTHER, "my-postgres:5432");
  assert.equal(r.env.FROM_COMPOSE, "postgres:5432");
  assert.deepEqual(r.rewritten, ["DATABASE_URL"]);
});
