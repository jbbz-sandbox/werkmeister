/**
 * A temp `~/.sandbox` for tests that reach the machine-global config.
 *
 * CI runs on a clean machine: no `~/.sandbox/{config,services,ports}.yaml`, and
 * `loadServices`/`loadPorts` throw "Required config file not found" rather than
 * returning empty. A test that borrows the developer's real registry passes
 * locally and fails there — which is exactly how nine of these got merged.
 *
 * `SANDBOX_CONFIG_FILE` relocates the whole set (see `configPath` in config.ts),
 * so pointing it at a seeded temp dir makes a test hermetic in one move.
 *
 * Not named `*.test.mjs` on purpose: the suite globs that pattern.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Two services with the coordinates the endpoint and detect paths read. */
const SERVICES = `services:
  backend:
    type: api
    repo: demo-repo
    port_offset: 2
    k8s_forward_port: 9052
    k8s_namespace: dev
    k8s_deployment: backend
  frontend:
    type: web
    repo: demo-repo
    port_offset: 3
`;

const PORTS = `feature_slots:
  count: 12
  base_port: 11100
  ports_per_slot: 20
`;

/**
 * Run *fn* against a seeded temp sandbox home.
 *
 * `overrides` merges extra top-level YAML into config.yaml (e.g. a
 * `standards_dir`). `services`/`ports` replace the defaults above when a test
 * needs a different registry. Restores the previous env and removes the dir.
 */
export async function withSandboxHome(fn, { services = SERVICES, ports = PORTS, config = "" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-home-"));
  const cfg = path.join(home, "config.yaml");
  fs.writeFileSync(cfg, `version: 1\n${config}`);
  fs.writeFileSync(path.join(home, "services.yaml"), services);
  fs.writeFileSync(path.join(home, "ports.yaml"), ports);

  const prev = process.env.SANDBOX_CONFIG_FILE;
  process.env.SANDBOX_CONFIG_FILE = cfg;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_CONFIG_FILE;
    else process.env.SANDBOX_CONFIG_FILE = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * True when a real Docker daemon answers.
 *
 * Tests that need live containers use this to skip rather than fail: CI has no
 * sandbox stack, and "no containers" is indistinguishable from "no daemon" in
 * most of these code paths.
 */
export async function dockerAvailable() {
  try {
    const { docker } = await import("./dist/docker.js");
    await docker().listContainers({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}
