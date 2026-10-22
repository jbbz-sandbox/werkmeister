/**
 * `up` checked (and restarted) the shared k8s-forwards container and started
 * Caddy for every workspace, so a werkmeister-only `up` restarted the forwarder
 * for everyone on 2026-10-18 (SW-42). Each kind of shared infra is now reached
 * only when a local service needs it. `needsCluster` and the routing table run
 * for real against the registry below; every other collaborator is mocked.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Reporter } from "werkmeister-core/reporter";
import { withReporter } from "werkmeister-core/reporter";

const registry: Record<string, Record<string, unknown>> = {
  cli: { type: "cli" },
  "sandbox-core": { type: "library" },
  "vscode-plugin": { type: "extension" },
  "sandbox-dashboard": { type: "web", feature_router: { hostname: "dash.local.test" } },
  backend: { type: "api", k8s_deployment: "backend" },
};
const spawned: string[] = [];

vi.mock("werkmeister-core/caddy", () => ({
  ensureSharedNetwork: vi.fn(() => true),
  isCaddyRunning: vi.fn(async () => false),
  reloadCaddy: vi.fn(async () => true),
  startCaddy: vi.fn(() => true),
}));
vi.mock("werkmeister-core/compose", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  composeUpAsync: vi.fn(async () => true),
}));
vi.mock("werkmeister-core/config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPorts: () => ({ slots: { start: 11000, size: 20 } }),
  loadServices: () => registry,
  loadSetupServices: () => ({}),
}));
vi.mock("werkmeister-core/generate", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateCaddyfile: async () => {},
  generateSupergraphConfig: () => null,
  isFeatureComposeStale: () => false,
  writeServiceSecretEnvs: () => {},
}));
vi.mock("werkmeister-core/k8s", () => ({
  ensurePortForwardsHealthy: vi.fn(async () => "healthy"),
  waitForForwards: vi.fn(async () => {}),
}));
vi.mock("werkmeister-core/proc", async (importOriginal) => {
  const record = (cmd: string[]) => {
    spawned.push(cmd.join(" "));
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    ...(await importOriginal<object>()),
    run: record,
    runAsync: async (cmd: string[]) => record(cmd),
  };
});
vi.mock("werkmeister-core/resources", () => ({
  withStartRecord: (_ws: string, _by: string, work: () => unknown) => work(),
}));
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

import {
  ensureSharedNetwork,
  isCaddyRunning,
  reloadCaddy,
  startCaddy,
} from "werkmeister-core/caddy";
import { ensurePortForwardsHealthy, waitForForwards } from "werkmeister-core/k8s";
import { up } from "werkmeister-core/lifecycle";

const quiet: Reporter = { passthrough: false, emit: () => {} };
let root: string;

function workspace(services: string[]): string {
  fs.writeFileSync(path.join(root, ".env"), `SANDBOX_SLOT=3\nSERVICES=${services.join(",")}\n`);
  return root;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "up-infra-"));
  fs.writeFileSync(path.join(root, "compose.yml"), "services: {}\n");
  fs.mkdirSync(path.join(root, ".sandbox"));
  fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), "context_strategy: icm\n");
  spawned.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle.up starts shared infra only when needed", () => {
  it("a werkmeister-only workspace neither checks the forwards nor starts Caddy", async () => {
    const result = await withReporter(quiet, () =>
      up("demo", workspace(["cli", "sandbox-core", "vscode-plugin"])),
    );
    expect(ensurePortForwardsHealthy).not.toHaveBeenCalled();
    expect(waitForForwards).not.toHaveBeenCalled();
    expect(startCaddy).not.toHaveBeenCalled();
    expect(ensureSharedNetwork).toHaveBeenCalled();
    expect(result.caddy).toBe("skipped");
  });

  it("a running Caddy is still reloaded for a werkmeister-only workspace", async () => {
    vi.mocked(isCaddyRunning).mockResolvedValueOnce(true);
    const result = await withReporter(quiet, () => up("demo", workspace(["cli"])));
    expect(reloadCaddy).toHaveBeenCalled();
    expect(result.caddy).toBe("reloaded");
  });

  it("a routed workspace starts Caddy but leaves the forwards alone", async () => {
    const result = await withReporter(quiet, () => up("demo", workspace(["sandbox-dashboard"])));
    expect(ensurePortForwardsHealthy).not.toHaveBeenCalled();
    expect(startCaddy).toHaveBeenCalled();
    expect(result.caddy).toBe("started");
  });

  it("a cluster-backed workspace checks the forwards and waits after a restart", async () => {
    vi.mocked(ensurePortForwardsHealthy).mockResolvedValueOnce("restarted");
    const result = await withReporter(quiet, () => up("demo", workspace(["backend"])));
    expect(ensurePortForwardsHealthy).toHaveBeenCalledTimes(1);
    expect(waitForForwards).toHaveBeenCalledTimes(1);
    expect(result.caddy).toBe("started");
  });

  it("never spawns anything that starts jaeger or redisinsight", async () => {
    for (const services of [["cli"], ["sandbox-dashboard"], ["backend"]]) {
      await withReporter(quiet, () => up("demo", workspace(services)));
    }
    expect(spawned.filter((cmd) => /jaeger|redisinsight/.test(cmd))).toEqual([]);
  });
});
