// generateSupergraphConfig is opt-in: with no graphql-type service in the
// registry it returns null and must leave the workspace untouched (#119).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateSupergraphConfig } from "./dist/generate.js";

const PORTS = { slots: { start: 11000, size: 20 } };

test("no subgraph: returns null and does not create .sandbox/", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "sandbox-supergraph-"));
  const config = { services: { web: { type: "node" } }, ports: PORTS };
  assert.equal(generateSupergraphConfig("f", 1, [], config, ws), null);
  assert.equal(existsSync(path.join(ws, ".sandbox")), false);
});

test("subgraph: creates .sandbox/ and writes the supergraph config", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "sandbox-supergraph-"));
  const config = {
    services: { api: { type: "graphql-subgraph", internal_port: 4000 } },
    ports: PORTS,
  };
  const out = generateSupergraphConfig("f", 1, ["api"], config, ws);
  assert.equal(out, path.join(ws, ".sandbox", "supergraph-config.yml"));
  assert.ok(existsSync(out));
});
