// SW-102: a `{service}` ref can resolve to a non-k8s `baseline_upstream`, and
// w9r-infra can run that baseline from a digest-pinned image in config.yaml.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parse as parseYaml } from "yaml";

import { baselineSpecs, renderBaselineOverride } from "./dist/baseline.js";
import { baselineUpstream } from "./dist/config.js";
import { renderK8sForwardsOverride } from "./dist/k8s_forwards.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SERVICES = { demo: { internal_port: 80 }, api: {} };

test("baselineUpstream: absent is null, host:port splits on the last colon", () => {
  assert.equal(baselineUpstream("demo", {}), null);
  assert.equal(baselineUpstream("demo", { baseline_upstream: null }), null);
  assert.deepEqual(baselineUpstream("demo", { baseline_upstream: "h:80" }), {
    host: "h",
    port: 80,
  });
  assert.deepEqual(baselineUpstream("demo", { baseline_upstream: "[::1]:80" }), {
    host: "[::1]",
    port: 80,
  });
});

test("baselineUpstream: anything but host:port throws naming the service", () => {
  for (const bad of ["h", "h:0", "h:70000", "h:", 80]) {
    assert.throws(
      () => baselineUpstream("demo", { baseline_upstream: bad }),
      /'demo'\.baseline_upstream must be host:port/,
      String(bad),
    );
  }
});

test("baselineSpecs: no infra.baseline is none", () => {
  assert.deepEqual(baselineSpecs({}, SERVICES), []);
  assert.deepEqual(baselineSpecs({ infra: { profiles: ["jaeger"] } }, SERVICES), []);
});

test("baselineSpecs: takes the port from services.yaml and stringifies env", () => {
  const config = {
    infra: { baseline: { demo: { image: `traefik/whoami@${DIGEST}`, environment: { N: 1 } } } },
  };
  assert.deepEqual(baselineSpecs(config, SERVICES), [
    { service: "demo", image: `traefik/whoami@${DIGEST}`, port: 80, environment: { N: "1" } },
  ]);
  const api = baselineSpecs({ infra: { baseline: { api: { image: `x@${DIGEST}` } } } }, SERVICES);
  assert.equal(api[0].port, 3000, "internal_port defaults like resolveServiceRefs");
});

test("baselineSpecs: refuses an unknown service, a tag-only image and a nested env", () => {
  const spec = (service, entry) => () =>
    baselineSpecs({ infra: { baseline: { [service]: entry } } }, SERVICES);
  assert.throws(spec("ghost", { image: `x@${DIGEST}` }), /infra\.baseline\.ghost: no such service/);
  assert.throws(spec("demo", { image: "traefik/whoami:latest" }), /must be pinned.*docker inspect/);
  assert.throws(spec("demo", {}), /must be pinned/);
  assert.throws(
    spec("demo", { image: `x@${DIGEST}`, environment: { A: { b: 1 } } }),
    /environment must be a map of plain values/,
  );
});

test("renderBaselineOverride: none is an empty services map", () => {
  assert.deepEqual(parseYaml(renderBaselineOverride([])), { services: {} });
});

test("renderBaselineOverride: one container per spec, aliased baseline-<svc> on both networks", () => {
  const image = `traefik/whoami@${DIGEST}`;
  const out = renderBaselineOverride([
    { service: "demo", image, port: 80, environment: {} },
    {
      service: "api",
      image,
      port: 3000,
      environment: { DATABASE_URL: "postgres://u:p@db:5432/x" },
    },
  ]);
  assert.match(out, /^# AUTO-GENERATED/);
  const { services } = parseYaml(out);
  const net = { aliases: ["baseline-demo"] };
  assert.deepEqual(services["baseline-demo"], {
    image,
    container_name: "w9r-baseline-demo",
    restart: "unless-stopped",
    networks: { "shared-network": net, "werkmeister-shared": net },
  });
  assert.equal(services["baseline-api"].environment.DATABASE_URL, "postgres://u:p@db:5432/x");
  assert.equal(services["baseline-api"].ports, undefined, "reached over the shared network only");
});

// Reads and merges files only; starts nothing.
const hasCompose = spawnSync("docker", ["compose", "version"]).status === 0;
test("docker compose accepts the shipped file merged with both overrides", {
  skip: !hasCompose && "docker compose not available",
}, () => {
  const state = fs.mkdtempSync(path.join(tmpdir(), "baseline-compose-"));
  const infra = path.join(state, "infra");
  fs.mkdirSync(path.join(infra, "compose"), { recursive: true });
  fs.writeFileSync(path.join(state, "secrets.env"), "");
  fs.writeFileSync(path.join(state, "corp-ca.crt"), "");
  const k8s = path.join(infra, "compose", "k8s-forwards.override.yml");
  const baseline = path.join(infra, "compose", "baseline.override.yml");
  fs.writeFileSync(k8s, renderK8sForwardsOverride([]));
  fs.writeFileSync(
    baseline,
    renderBaselineOverride([
      { service: "demo", image: `traefik/whoami@${DIGEST}`, port: 80, environment: {} },
    ]),
  );
  const shipped = path.resolve(
    import.meta.dirname,
    "../../apps/cli/infra/compose/shared-infra.yml",
  );
  const r = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      shipped,
      "-f",
      k8s,
      "-f",
      baseline,
      "-p",
      "w9r-infra",
      "config",
      "--format",
      "json",
    ],
    { cwd: state, env: { ...process.env, SANDBOX_STATE_DIR: infra }, encoding: "utf8" },
  );
  fs.rmSync(state, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const demo = JSON.parse(r.stdout).services["baseline-demo"];
  assert.equal(demo.container_name, "w9r-baseline-demo");
  assert.deepEqual(Object.keys(demo.networks).sort(), ["shared-network", "werkmeister-shared"]);
});
