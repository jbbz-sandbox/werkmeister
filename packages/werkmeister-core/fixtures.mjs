/**
 * A temp `~/.werkmeister` for tests that reach the machine-global config.
 *
 * CI runs on a clean machine: no `~/.werkmeister/{config,services,ports}.yaml`, and
 * `loadServices`/`loadPorts` throw "Required config file not found" rather than
 * returning empty. A test that borrows the developer's real registry passes
 * locally and fails there — which is exactly how nine of these got merged.
 *
 * `WERKMEISTER_CONFIG_FILE` relocates the whole set (see `configPath` in config.ts),
 * so pointing it at a seeded temp dir makes a test hermetic in one move.
 *
 * Not named `*.test.mjs` on purpose: the suite globs that pattern.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before } from "node:test";

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
 * Pin `WERKMEISTER_ROOT` to this checkout's `apps/cli` for the calling test file.
 *
 * Developer shells export it at the main checkout, and `sandboxRoot()` honours it
 * first, so a direct `node --test x.test.mjs` would otherwise build, spawn or
 * write there (SW-137, SW-168). `turbo` filters it out, which hides the problem.
 * Call once at the top level of any test that reaches `sandboxRoot()` and does
 * not set its own root. It also sets `WERKMEISTER_ROOT_PINNED`, which disarms the
 * SW-239 guard in `sandboxRoot()`: a test that never pins fails there.
 */
export function pinWerkmeisterRoot() {
  let prev;
  let prevPinned;
  before(() => {
    prev = process.env.WERKMEISTER_ROOT;
    prevPinned = process.env.WERKMEISTER_ROOT_PINNED;
    process.env.WERKMEISTER_ROOT = path.resolve(import.meta.dirname, "..", "..", "apps", "cli");
    process.env.WERKMEISTER_ROOT_PINNED = "1";
  });
  after(() => {
    if (prev === undefined) delete process.env.WERKMEISTER_ROOT;
    else process.env.WERKMEISTER_ROOT = prev;
    if (prevPinned === undefined) delete process.env.WERKMEISTER_ROOT_PINNED;
    else process.env.WERKMEISTER_ROOT_PINNED = prevPinned;
  });
}

/**
 * Let the calling test file reach a Docker engine: the real one, or the fake
 * its own `DOCKER_HOST` points at.
 *
 * Without it, `resolveEndpoint()` hands a test a dead socket (SW-259), so a test
 * can't read host containers by accident — another workspace's containers on a
 * test's slot failed SW-245's gate. Call once at the top level, like
 * `pinWerkmeisterRoot()`.
 */
export function useDockerEngine() {
  let prev;
  before(() => {
    prev = process.env.WERKMEISTER_DOCKER_ENGINE;
    process.env.WERKMEISTER_DOCKER_ENGINE = "1";
  });
  after(() => {
    if (prev === undefined) delete process.env.WERKMEISTER_DOCKER_ENGINE;
    else process.env.WERKMEISTER_DOCKER_ENGINE = prev;
  });
}

/**
 * Run *fn* against a seeded temp werkmeister home.
 *
 * `overrides` merges extra top-level YAML into config.yaml (e.g. a
 * `standards_dir`). `services`/`ports` replace the defaults above when a test
 * needs a different registry. Restores the previous env and removes the dir.
 */
export async function withSandboxHome(
  fn,
  { services = SERVICES, ports = PORTS, config = "" } = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-home-"));
  const cfg = path.join(home, "config.yaml");
  fs.writeFileSync(cfg, `version: 1\n${config}`);
  fs.writeFileSync(path.join(home, "services.yaml"), services);
  fs.writeFileSync(path.join(home, "ports.yaml"), ports);

  const prev = process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_CONFIG_FILE = cfg;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * True when a real Docker daemon answers.
 *
 * Tests that need live containers use this to skip rather than fail: CI has no
 * werkmeister stack, and "no containers" is indistinguishable from "no daemon" in
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

/**
 * Run *fn* with $WERKMEISTER_GH_BIN pointing at a fake `gh`: `issue view` prints
 * `issue` as JSON (exit 1 when null), `auth status` exits `auth`, `repo view` exits `repoView`.
 * Like the real repo, `issue edit --add-label` fails for a label not in `labels`;
 * `label create` adds one. `project item-list` prints `{ items }`, `issue list` prints
 * `issues` (for every repo). `api user` prints `octo`, `search prs` prints `[]`.
 * Every call is a line in `<dir>/calls`; any other subcommand exits 1, so a code path
 * the fake doesn't cover fails the test instead of passing on empty output (SW-148).
 */
export async function withFakeGh(
  { issue = null, auth = 0, repoView = 0, labels = [], items = [], issues = [] } = {},
  fn,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-"));
  fs.writeFileSync(path.join(dir, "issue.json"), JSON.stringify(issue));
  fs.writeFileSync(path.join(dir, "items.json"), JSON.stringify({ items }));
  fs.writeFileSync(path.join(dir, "issues.json"), JSON.stringify(issues));
  fs.writeFileSync(path.join(dir, "labels"), labels.map((l) => `${l}\n`).join(""));
  const bin = path.join(dir, "gh");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> '${dir}/calls'
case "$1 $2" in
  "label create") grep -qxF "$3" '${dir}/labels' || echo "$3" >> '${dir}/labels';;
  "issue edit") if [ "$6" = "--add-label" ] && ! grep -qxF "$7" '${dir}/labels'; then echo "'$7' not found" >&2; exit 1; fi;;
  "issue view") if [ "$(cat '${dir}/issue.json')" = "null" ]; then echo "could not resolve" >&2; exit 1; fi; cat '${dir}/issue.json';;
  "auth status") if [ ${auth} = 0 ]; then echo "  ✓ Logged in to github.com account octo (keyring)" >&2; else echo "You are not logged into any GitHub hosts." >&2; fi; exit ${auth};;
  "repo view") exit ${repoView};;
  "project item-list") cat '${dir}/items.json';;
  "issue list") cat '${dir}/issues.json';;
  "issue close"|"issue comment") ;;
  "api user") echo octo;;
  "search prs") echo '[]';;
  *) echo "fake gh: unhandled: $*" >&2; exit 1;;
esac
`,
    { mode: 0o755 },
  );
  const prev = process.env.WERKMEISTER_GH_BIN;
  process.env.WERKMEISTER_GH_BIN = bin;
  try {
    return await fn(bin);
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_GH_BIN;
    else process.env.WERKMEISTER_GH_BIN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `hooks` plus the agent-state entry every workspace gets on each of its events (SW-46). */
export async function withAgentState(hooks) {
  const { AGENT_STATE_EVENTS, buildAgentStateEntry } = await import("./dist/hooks_gen.js");
  const out = { ...hooks };
  for (const event of AGENT_STATE_EVENTS)
    out[event] = [...(out[event] ?? []), buildAgentStateEntry()];
  return out;
}
