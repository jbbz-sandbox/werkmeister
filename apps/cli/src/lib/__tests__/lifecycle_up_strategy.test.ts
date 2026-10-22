/**
 * `up` used to re-install the JIT hooks into every workspace, including an ICM
 * one (docs/superpowers/specs/2026-09-27-context-strategy-interface.md at 66703fc). It
 * now calls the workspace's strategy's refresh.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_FILE, LEGACY_COMPOSE_FILE } from "werkmeister-core/compose_file";
import {
  AGENT_STATE_EVENTS,
  buildAgentStateEntry,
  buildPrGuardEntry,
  READ_ONLY_GIT_RULES,
  SESSION_START_COMMAND,
} from "werkmeister-core/hooks_gen";
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

const quiet: Reporter = { passthrough: false, emit: () => {} };
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "up-strategy-"));
  fs.writeFileSync(path.join(root, COMPOSE_FILE), "services: {}\n");
  fs.writeFileSync(path.join(root, ".env"), "SANDBOX_SLOT=3\nSERVICES=\n");
  fs.mkdirSync(path.join(root, ".sandbox"));
  fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), "context_strategy: icm\n");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** `hooks` plus the agent-state entry `up` adds on each of its events (SW-46). */
const withAgentState = (hooks: Record<string, unknown[]>) => {
  const out = { ...hooks };
  for (const event of AGENT_STATE_EVENTS)
    out[event] = [...(out[event] ?? []), buildAgentStateEntry()];
  return out;
};

describe("lifecycle.up in an icm workspace", () => {
  it("installs the PR guard and allow rules, what both strategies share", async () => {
    await withReporter(quiet, () => up("demo", root));
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      hooks: withAgentState({ PreToolUse: [buildPrGuardEntry()] }),
      permissions: { allow: READ_ONLY_GIT_RULES },
    });
  });

  it("renames a legacy compose file before bringing the stack up", async () => {
    fs.renameSync(path.join(root, COMPOSE_FILE), path.join(root, LEGACY_COMPOSE_FILE));
    await withReporter(quiet, () => up("demo", root));
    expect(fs.existsSync(path.join(root, COMPOSE_FILE))).toBe(true);
    expect(fs.existsSync(path.join(root, LEGACY_COMPOSE_FILE))).toBe(false);
  });

  it("heals a workspace a pre-strategy up polluted", async () => {
    const hand = { hooks: [{ type: "command", command: "echo mine" }] };
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [hand, { hooks: [{ type: "command", command: SESSION_START_COMMAND }] }],
        },
      }),
    );
    await withReporter(quiet, () => up("demo", root));
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      hooks: withAgentState({ SessionStart: [hand], PreToolUse: [buildPrGuardEntry()] }),
      permissions: { allow: READ_ONLY_GIT_RULES },
    });
  });
});
