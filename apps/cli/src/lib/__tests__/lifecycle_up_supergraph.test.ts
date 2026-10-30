/**
 * `up` called `generateSupergraphConfig` only when the slot changed, so a
 * stale `.werkmeister/supergraph-config.yml` from before federation went opt-in
 * survived a plain `up` (#120). Every collaborator of `up` is mocked except
 * `generateSupergraphConfig`, which runs for real against the mocked registry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_FILE } from "werkmeister-core/compose_file";
import type { Reporter } from "werkmeister-core/reporter";
import { withReporter } from "werkmeister-core/reporter";

const registry = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));

vi.mock("werkmeister-core/caddy", () => ({
  ensureSharedNetwork: () => true,
  isCaddyRunning: () => true,
  reloadCaddy: async () => {},
  startCaddy: vi.fn(),
}));
vi.mock("werkmeister-core/compose", () => ({ composeUp: () => true }));
vi.mock("werkmeister-core/config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPorts: () => ({ slots: { start: 11000, size: 20 } }),
  loadServices: () => registry.services,
}));
vi.mock("werkmeister-core/feature_routing", () => ({ loadFeatureRouters: () => ({}) }));
vi.mock("werkmeister-core/generate", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateCaddyfile: async () => {},
  isFeatureComposeStale: () => false,
  loadWorkspaceEnvVars: () => ({}),
  writeServiceSecretEnvs: () => {},
}));
vi.mock("werkmeister-core/k8s", () => ({ ensurePortForwardsHealthy: () => "healthy" }));
vi.mock("werkmeister-core/secrets", () => ({
  getSecretsPath: () => "/nonexistent/secrets.yaml",
  loadSecrets: () => ({}),
  resolveSecrets: () => ({ byService: {}, missing: [] }),
}));
vi.mock("werkmeister-core/slots", () => ({
  requireLeasedSlot: async () => 3,
  getPortRange: () => [3300, 3399],
  getServicePort: () => 3300,
}));

import { up } from "werkmeister-core/lifecycle";

const quiet: Reporter = { passthrough: false, emit: () => {} };
let root: string;
let supergraph: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "up-supergraph-"));
  fs.writeFileSync(path.join(root, COMPOSE_FILE), "services: {}\n");
  // Slot 3 matches allocateSlot, so `up` takes the unchanged-slot path.
  fs.writeFileSync(path.join(root, ".env"), "WERKMEISTER_SLOT=3\nSERVICES=\n");
  fs.mkdirSync(path.join(root, ".werkmeister"));
  fs.writeFileSync(path.join(root, ".werkmeister", "workspace.yml"), "context_strategy: icm\n");
  supergraph = path.join(root, ".werkmeister", "supergraph-config.yml");
  fs.writeFileSync(supergraph, "# stale\n");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle.up with an unchanged slot", () => {
  it("removes a stale supergraph config when the registry has no subgraph", async () => {
    registry.services = { web: { type: "node" } };
    await withReporter(quiet, () => up("demo", root));
    expect(fs.existsSync(supergraph)).toBe(false);
  });

  it("rewrites the supergraph config when the registry has a subgraph", async () => {
    registry.services = { api: { type: "graphql-subgraph", internal_port: 4000 } };
    await withReporter(quiet, () => up("demo", root));
    expect(fs.readFileSync(supergraph, "utf8")).not.toBe("# stale\n");
  });
});
