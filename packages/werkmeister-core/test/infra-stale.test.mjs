// SW-610: a shared-infra container made from an old checkout path keeps that path's
// bind mounts (Caddy's picker UI), and nothing recreated it. staleInfraReason flags
// one; infraHealth counts caddy unhealthy when its picker page is missing. A fake
// Engine on a unix socket stands in for the daemon: nothing touches the live w9r-*.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Set before the imports below, which resolve the endpoint; useDockerEngine()'s hook runs too late. Own process, so no restore.
process.env.WERKMEISTER_DOCKER_ENGINE = "1";

const dir = fs.mkdtempSync(path.join(tmpdir(), "infra-stale-"));
const sock = path.join(dir, "docker.sock");
process.env.DOCKER_HOST = `unix://${sock}`;

const { recreatePlan, staleInfraReason } = await import("../dist/compose_infra.js");
const { infraHealth } = await import("../dist/infra.js");

const shipped = path.join(dir, "checkout", "apps/cli/infra/compose/shared-infra.yml");
const ui = path.join(dir, "checkout", "apps/cli/infra/proxy/ui");
fs.mkdirSync(ui, { recursive: true });
const labels = (file) => ({ "com.docker.compose.project.config_files": `${file},/x/override.yml` });

test("same compose file and live binds: not stale", () => {
  const c = { Labels: labels(shipped), Mounts: [{ Type: "bind", Source: ui }] };
  assert.equal(staleInfraReason(c, shipped), null);
});

test("made from another checkout's compose file: stale, naming it", () => {
  const old = "/Users/me/repos/sandbox/apps/cli/infra/compose/shared-infra.yml";
  assert.equal(
    staleInfraReason({ Labels: labels(old), Mounts: [] }, shipped),
    `created from ${old}`,
  );
});

// From a container the host's bind sources don't exist (w9r-caddy's ~/.docker/certs, stage 03).
test("same compose file, bind source absent from this process's view: not stale", () => {
  const c = {
    Labels: labels(shipped),
    Mounts: [{ Type: "bind", Source: path.join(dir, "absent") }],
  };
  assert.equal(staleInfraReason(c, shipped), null);
});

test("no config_files label (not made by compose): not stale", () => {
  assert.equal(staleInfraReason({ Labels: {}, Mounts: [] }, shipped), null);
});

// Stage 03 review: `compose up --force-recreate <name>` fails every run for a service the file dropped.
test("recreatePlan recreates only services this run starts; the rest are leftovers", () => {
  const stale = (name, service) => ({
    name,
    service,
    reason: "created from /old/shared-infra.yml",
  });
  const plan = recreatePlan(
    [
      stale("w9r-k8s-forwards", "k8s-forwards"),
      stale("w9r-redis", "redis"),
      stale("w9r-caddy", "caddy"),
    ],
    ["k8s-forwards", "caddy", "baseline-db"],
  );
  assert.deepEqual(plan.recreate, ["k8s-forwards", "caddy"]);
  assert.deepEqual(
    plan.leftover.map((s) => s.name),
    ["w9r-redis"],
  );
  assert.deepEqual(recreatePlan([], ["caddy"]), { recreate: [], leftover: [] });
});

let pickerExit;
const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://engine").pathname.replace(/^\/v[\d.]+/, "");
  req.resume();
  const json = (status, body) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (p === "/containers/json")
    return json(200, [
      {
        Id: "caddy0001",
        Names: ["/w9r-caddy"],
        State: "running",
        Status: "Up 1 hour",
        Labels: {
          "com.docker.compose.project": "w9r-infra",
          "com.docker.compose.service": "caddy",
          "com.docker.compose.oneoff": "False",
        },
        Ports: [],
      },
    ]);
  if (p === "/containers/w9r-caddy/exec") return json(201, { Id: "exec1" });
  if (p === "/exec/exec1/start")
    return res.writeHead(200, { "content-type": "application/vnd.docker.raw-stream" }).end();
  if (p === "/exec/exec1/json") return json(200, { ExitCode: pickerExit });
  json(404, { message: `fake engine: unhandled ${req.method} ${p}` });
});
await new Promise((r) => server.listen(sock, r));
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("caddy running with its picker page: healthy", async () => {
  pickerExit = 0;
  assert.deepEqual(await infraHealth(0), { caddy: true });
});

test("caddy running with an empty picker mount: unhealthy", async () => {
  pickerExit = 1;
  assert.deepEqual(await infraHealth(0), { caddy: false });
});
