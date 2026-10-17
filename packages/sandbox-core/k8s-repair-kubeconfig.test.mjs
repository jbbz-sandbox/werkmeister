// #97: a forwarder created while the host kubeconfig was missing gets a
// Docker-made directory bind-mounted in its place. Force-recreating re-mounts
// that same directory, so the repair must rewrite the kubeconfig first.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ensurePortForwardsHealthy } from "./dist/k8s.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";

const VARS = ["SANDBOX_CONFIG_FILE", "SANDBOX_SERVICES_YAML", "SANDBOX_ROOT", "PATH"];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

let home, kubeconfig, upLog;

function stub(bin, dir, script) {
  const p = path.join(dir, bin);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sandbox-k8s-repair-"));
  process.env.SANDBOX_CONFIG_FILE = path.join(home, "config.yaml");
  writeFileSync(path.join(home, "services.yaml"), "services: {}\n");
  process.env.SANDBOX_SERVICES_YAML = path.join(home, "services.yaml");
  process.env.SANDBOX_ROOT = path.resolve(import.meta.dirname, "..", "..", "apps", "cli");

  kubeconfig = path.join(home, "infra", "k8s-port-forward", "kubeconfig");
  mkdirSync(kubeconfig, { recursive: true });
  upLog = path.join(home, "up.log");

  const bin = path.join(home, "bin");
  mkdirSync(bin);
  stub(
    "docker",
    bin,
    `
case "$*" in
  *" ps "*) echo '{"State":"running","Health":"unhealthy"}' ;;
  *" up "*) [ -f "${kubeconfig}" ] && echo file > "${upLog}" || echo notfile > "${upLog}" ;;
esac`,
  );
  process.env.PATH = `${bin}:${SAVED.PATH}`;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v];
  }
});

test("replaces a directory kubeconfig with a real file before recreating", () => {
  stub(
    "kubectl",
    path.join(home, "bin"),
    `
case "$*" in
  *"config view"*) printf 'clusters:\\n- cluster:\\n    server: https://127.0.0.1:26443\\n' ;;
  *current-context*) echo orbstack ;;
esac`,
  );

  assert.equal(ensurePortForwardsHealthy(), "restarted");
  assert.ok(statSync(kubeconfig).isFile());
  assert.match(readFileSync(kubeconfig, "utf8"), /server: https:\/\/host\.docker\.internal:26443/);
  assert.equal(
    readFileSync(upLog, "utf8").trim(),
    "file",
    "kubeconfig was a file when compose up ran",
  );
});

test("fails without recreating when the kubeconfig can't be regenerated", async () => {
  stub("kubectl", path.join(home, "bin"), "echo 'no context' >&2; exit 1");

  const reporter = collectingReporter();
  assert.equal(await withReporter(reporter, async () => ensurePortForwardsHealthy()), "failed");
  assert.match(reporter.text(), /Not restarting k8s-forwards without a kubeconfig file/);
  assert.throws(() => statSync(upLog), /ENOENT/, "compose up never ran");
});
