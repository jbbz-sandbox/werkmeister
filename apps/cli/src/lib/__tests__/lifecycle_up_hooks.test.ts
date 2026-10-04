/**
 * `writeWorkspaceHooks` used to run only from init-workspace, so a workspace
 * created before a hook-template change kept the stale SessionStart hook
 * until someone re-ran it by hand (known-issues.md, "Library Rough Edges").
 * Every collaborator of `up` is mocked; only the hook write is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SESSION_START_COMMAND } from "sandbox-core/hooks_gen";
import type { Reporter } from "sandbox-core/reporter";
import { withReporter } from "sandbox-core/reporter";

vi.mock("sandbox-core/caddy", () => ({
  isCaddyRunning: () => true,
  reloadCaddy: async () => {},
  startCaddy: vi.fn(),
}));
vi.mock("sandbox-core/compose", () => ({ composeUp: () => true }));
vi.mock("sandbox-core/config", () => ({ loadPorts: () => ({}), loadServices: () => ({}) }));
vi.mock("sandbox-core/feature_routing", () => ({ loadFeatureRouters: () => ({}) }));
vi.mock("sandbox-core/generate", () => ({
  generateCaddyfile: async () => {},
  isFeatureComposeStale: () => false,
  writeServiceSecretEnvs: () => {},
}));
vi.mock("sandbox-core/k8s", () => ({ ensurePortForwardsHealthy: () => "healthy" }));
vi.mock("sandbox-core/secrets", () => ({
  getSecretsPath: () => "/nonexistent/secrets.yaml",
  loadSecrets: () => ({}),
  resolveSecrets: () => ({ byService: {}, missing: [] }),
}));
vi.mock("sandbox-core/slots", () => ({
  allocateSlot: async () => 3,
  getPortRange: () => [3300, 3399],
  getServicePort: () => 3300,
}));

import { up } from "sandbox-core/lifecycle";

/** The shape shipped before skills self-healing — what real workspaces hold. */
const PRIOR_COMMAND = "command -v sandbox >/dev/null 2>&1 && sandbox notes context || true";

const quiet: Reporter = { passthrough: false, emit: () => {} };
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "up-hooks-"));
  fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(root, ".env"), "SANDBOX_SLOT=3\nSERVICES=\n");
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: PRIOR_COMMAND }] }] } }),
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle.up", () => {
  it("reconciles a stale SessionStart hook", async () => {
    await withReporter(quiet, () => up("demo", root));

    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(SESSION_START_COMMAND);
  });
});
