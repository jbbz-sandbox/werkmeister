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
  "werkmeister-core": { type: "library" },
  "werkmeister-vscode": { type: "extension" },
  "werkmeister-dashboard": { type: "web", feature_router: { hostname: "dash.local.test" } },
  backend: { type: "api", k8s_deployment: "backend" },
  "smart-app": { type: "web", repo: "fhir" },
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
  getContainerStatus: vi.fn(async () => []),
  // The real one asks the host's daemon for a legacy project (SW-1012 review).
  liveProject: vi.fn(async (feature: string) => `werkmeister-${feature}`),
}));
const dockerStarted: string[] = [];
vi.mock("werkmeister-core/docker", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  containerLogs: vi.fn(
    async (_p: string, service: string, _o: unknown, onLine: (l: string) => void) =>
      onLine(`${service} | docs-site#build exited (4)`),
  ),
  docker: () => ({
    getContainer: (name: string) => ({
      start: async () => {
        if (name.includes("broken")) throw new Error("no such container");
        dockerStarted.push(name);
      },
    }),
  }),
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
  requireLeasedSlot: async () => 3,
  getPortRange: () => [3300, 3399],
  getServicePort: () => 3300,
}));

import {
  ensureSharedNetwork,
  isCaddyRunning,
  reloadCaddy,
  startCaddy,
} from "werkmeister-core/caddy";
import { composeUpAsync, getContainerStatus } from "werkmeister-core/compose";
import { ensurePortForwardsHealthy, waitForForwards } from "werkmeister-core/k8s";
import { up } from "werkmeister-core/lifecycle";

const quiet: Reporter = { passthrough: false, emit: () => {} };
let root: string;

function workspace(services: string[]): string {
  fs.writeFileSync(path.join(root, ".env"), `WERKMEISTER_SLOT=3\nSERVICES=${services.join(",")}\n`);
  return root;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "up-infra-"));
  fs.writeFileSync(path.join(root, "compose.yml"), "services: {}\n");
  fs.mkdirSync(path.join(root, ".werkmeister"));
  fs.writeFileSync(path.join(root, ".werkmeister", "workspace.yml"), "context_strategy: icm\n");
  spawned.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle.up starts shared infra only when needed", () => {
  it("a werkmeister-only workspace neither checks the forwards nor starts Caddy", async () => {
    const result = await withReporter(quiet, () =>
      up("demo", workspace(["cli", "werkmeister-core", "werkmeister-vscode"])),
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
    const result = await withReporter(quiet, () =>
      up("demo", workspace(["werkmeister-dashboard"])),
    );
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

  it("with nothing local, names the on-demand services and how to start one (SW-342)", async () => {
    fs.mkdirSync(path.join(root, "fhir"));
    const msgs: string[] = [];
    await withReporter({ passthrough: false, emit: (e) => "msg" in e && msgs.push(e.msg) }, () =>
      up("demo", workspace([])),
    );
    expect(msgs).toContain("start one with: werkmeister feature up --service <name> (smart-app)");
  });

  it("never spawns anything that starts jaeger or redisinsight", async () => {
    for (const services of [["cli"], ["werkmeister-dashboard"], ["backend"]]) {
      await withReporter(quiet, () => up("demo", workspace(services)));
    }
    expect(spawned.filter((cmd) => /jaeger|redisinsight/.test(cmd))).toEqual([]);
  });
});

// SW-973: compose ran out its 20 minutes with the core container left Created; `docker start` started it.
describe("lifecycle.up when compose gives up with a container left Created", () => {
  const box = (name: string, status: string, exitCode = 0) => ({
    name,
    status,
    health: "",
    ports: "",
    service: name.replace(/^demo-/, ""),
    role: name.endsWith("-setup") ? "setup" : "",
    exitCode,
  });
  beforeEach(() => {
    dockerStarted.length = 0;
    // What a plain `up` starts: `docs` is on-demand (a profile).
    fs.writeFileSync(
      path.join(root, "compose.yml"),
      "services:\n  install-setup: {}\n  core: {}\n  broken: {}\n  docs:\n    profiles: [docs]\n",
    );
  });
  const fails = async () => {
    await expect(withReporter(quiet, () => up("demo", workspace(["cli"])))).rejects.toThrow(
      /Failed to start containers/,
    );
    expect(dockerStarted).toEqual([]);
  };

  it("starts the Created container itself and carries on", async () => {
    vi.mocked(composeUpAsync).mockResolvedValueOnce(false);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      box("demo-install-setup", "exited"),
      box("demo-core", "created"),
    ]);
    const result = await withReporter(quiet, () => up("demo", workspace(["cli"])));
    expect(dockerStarted).toEqual(["demo-core"]);
    expect(result.containersStarted).toBe(true);
  });

  it("fails naming the container and `docker start` when it won't start", async () => {
    vi.mocked(composeUpAsync).mockResolvedValueOnce(false);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([box("demo-broken", "created")]);
    await expect(withReporter(quiet, () => up("demo", workspace(["cli"])))).rejects.toThrow(
      /demo-broken.*Created.*docker start demo-broken/s,
    );
  });

  it("leaves dependents of a failed container alone: compose's failure stands", async () => {
    vi.mocked(composeUpAsync).mockResolvedValueOnce(false);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      box("demo-install-setup", "exited", 1),
      box("demo-core", "created"),
    ]);
    await fails();
  });

  // SW-1012: the install's cause was only in `docker logs <ws>-werkmeister-install`.
  it("puts a failed setup's last lines in the error", async () => {
    vi.mocked(composeUpAsync).mockResolvedValueOnce(false);
    const failed = [box("demo-install-setup", "exited", 4), box("demo-core", "created")];
    // Once for startLeftCreated, once for the message.
    vi.mocked(getContainerStatus).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed);
    await expect(withReporter(quiet, () => up("demo", workspace(["cli"])))).rejects.toThrow(
      /demo-install-setup exited 4[^\n]*\n {2}install-setup \| docs-site#build exited \(4\)/,
    );
  });

  // Review: the timeout fires while a slow install still runs; core started then sees half a node_modules.
  it("leaves it while the install still runs or a dependency is still starting", async () => {
    for (const other of [
      box("demo-install-setup", "running"),
      { ...box("demo-broken", "running"), health: "starting" },
    ]) {
      vi.mocked(composeUpAsync).mockResolvedValueOnce(false);
      vi.mocked(getContainerStatus).mockResolvedValueOnce([other, box("demo-core", "created")]);
      await fails();
    }
  });

  it("never starts an on-demand service a failed `--service` start left Created", async () => {
    vi.mocked(composeUpAsync).mockResolvedValueOnce(false);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      box("demo-core", "running"),
      box("demo-docs", "created"),
    ]);
    await fails();
  });
});
