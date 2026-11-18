// SW-110: repos in one workspace that share a node_modules_volume name shared one volume.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { repoScopedNodeModules } from "../dist/generate.js";

const ws = (...repos) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nmv-"));
  for (const r of repos) fs.mkdirSync(path.join(root, r));
  return root;
};
const vol = ([svcs, setups]) =>
  Object.fromEntries(
    Object.entries({ ...svcs, ...setups }).map(([n, d]) => [n, d.node_modules_volume]),
  );

const SERVICES = {
  core: { repo: "werkmeister", node_modules_volume: "node-modules" },
  docs: { repo: "werkmeister", node_modules_volume: "node-modules" },
  api: { repo: "wellness", node_modules_volume: "node-modules" },
  app: { repo: "fhir", node_modules_volume: "fhir-node-modules" },
};
const SETUPS = { "wellness-install": { repo: "wellness", node_modules_volume: "node-modules" } };

test("a name two checked-out repos share gets the repo; same-repo sharing and other names stay", () => {
  assert.deepEqual(
    vol(repoScopedNodeModules([SERVICES, SETUPS], ws("werkmeister", "wellness", "fhir"))),
    {
      core: "werkmeister-node-modules",
      docs: "werkmeister-node-modules",
      api: "wellness-node-modules",
      app: "fhir-node-modules",
      "wellness-install": "wellness-node-modules",
    },
  );
});

test("one checked-out repo keeps its names, so an existing workspace keeps its volume", () => {
  assert.deepEqual(vol(repoScopedNodeModules([SERVICES, SETUPS], ws("werkmeister"))), {
    core: "node-modules",
    docs: "node-modules",
    api: "node-modules",
    app: "fhir-node-modules",
    "wellness-install": "node-modules",
  });
});
