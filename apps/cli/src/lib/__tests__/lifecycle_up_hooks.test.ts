/**
 * `writeWorkspaceHooks` used to run only from init-workspace, so a workspace
 * created before a hook-template change kept the stale SessionStart hook
 * until someone re-ran it by hand (known-issues.md, "Library Rough Edges").
 * Every collaborator of `up` is mocked; only the hook write is real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_FILE } from "werkmeister-core/compose_file";
import { SESSION_START_COMMAND } from "werkmeister-core/hooks_gen";
import type { Reporter } from "werkmeister-core/reporter";
import { withReporter } from "werkmeister-core/reporter";

vi.mock("werkmeister-core/caddy", () => ({
  ensureSharedNetwork: () => true,
  isCaddyRunning: () => true,
  reloadCaddy: async () => {},
  startCaddy: vi.fn(),
}));
vi.mock("werkmeister-core/compose", () => ({ composeUp: () => true }));
vi.mock("werkmeister-core/config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPorts: () => ({}),
  loadServices: () => ({}),
}));
vi.mock("werkmeister-core/feature_routing", () => ({ loadFeatureRouters: () => ({}) }));
vi.mock("werkmeister-core/generate", () => ({
  generateCaddyfile: async () => {},
  generateSupergraphConfig: () => null,
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
  allocateSlot: async () => 3,
  getPortRange: () => [3300, 3399],
  getServicePort: () => 3300,
}));

import { up } from "werkmeister-core/lifecycle";

/** The shape shipped before skills self-healing — what real workspaces hold. */
const PRIOR_COMMAND = "command -v sandbox >/dev/null 2>&1 && sandbox notes context || true";

const quiet: Reporter = { passthrough: false, emit: () => {} };
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "up-hooks-"));
  fs.writeFileSync(path.join(root, COMPOSE_FILE), "services: {}\n");
  fs.writeFileSync(path.join(root, ".env"), "WERKMEISTER_SLOT=3\nSERVICES=\n");
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: PRIOR_COMMAND }] }] },
    }),
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle.up", () => {
  it("reconciles a stale SessionStart hook", async () => {
    await withReporter(quiet, () => up("demo", root));

    const settings = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(SESSION_START_COMMAND);
  });
});
