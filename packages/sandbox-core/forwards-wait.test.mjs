// `docker compose up -d k8s-forwards` returns when the container runs, not when
// the kubectl tunnels inside it reconnect — a second later, in the case that
// prompted this. Anything needing a datastore that starts in that window dies on
// ECONNREFUSED and surfaces as a compose dependency error naming no forward at
// all. These pin the wait that closes the window: that it actually waits rather
// than probing once, and that giving up says which forwards never came back.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";

import { waitForForwards } from "./dist/k8s.js";

const VARS = ["SANDBOX_SERVICES_YAML", "SANDBOX_CONFIG_FILE", "SANDBOX_ROOT"];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let open = [];

/** A port nothing is listening on: bind an ephemeral one, then release it. */
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Answer every request with `+PONG`, so the redis wire probe passes. */
function serveRedis(port) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.on("data", () => sock.write("+PONG\r\n")));
    open.push(srv);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

/** A registry whose only forwards are redis-probed entries on *ports*. */
async function registry(ports) {
  const dir = await mkdtemp(path.join(tmpdir(), "sandbox-fwd-"));
  const file = path.join(dir, "services.yaml");
  const body = ports
    .map(
      (p, i) =>
        `  probe${i}:\n    k8s_forward_port: ${p}\n    internal_port: 6379\n` +
        `    k8s_namespace: default\n    k8s_pod_prefix: probe${i}\n    health_endpoint: redis\n`,
    )
    .join("");
  await writeFile(file, `services: {}\ninfrastructure:\n${body}`);
  process.env.SANDBOX_SERVICES_YAML = file;
}

beforeEach(() => VARS.forEach((v) => delete process.env[v]));
afterEach(() => {
  open.forEach((s) => s.close());
  open = [];
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("returns once every forward answers its probe", async () => {
  const ports = [await freePort(), await freePort()];
  await Promise.all(ports.map(serveRedis));
  await registry(ports);

  await waitForForwards(5_000, 50);
});

test("waits for a forward that is still reconnecting", async () => {
  // The whole point: at the first probe this port is refused, exactly as a
  // tunnel mid-reconnect is. A single-shot check would fail the run here.
  const port = await freePort();
  await registry([port]);

  const late = setTimeout(() => serveRedis(port), 300);
  try {
    await waitForForwards(10_000, 50);
  } finally {
    clearTimeout(late);
  }
});

test("names the forwards that never came back", async () => {
  const [alive, dead] = [await freePort(), await freePort()];
  await serveRedis(alive);
  await registry([alive, dead]);

  await assert.rejects(
    () => waitForForwards(200, 50),
    (e) => {
      assert.equal(e.code, "FORWARDS_NEVER_READY");
      assert.match(e.message, new RegExp(`probe1:${dead}`));
      // The one that answered is not blamed alongside it.
      assert.doesNotMatch(e.message, new RegExp(`probe0:${alive}`));
      return true;
    },
  );
});

test("a forward that hangs up without replying fails the wait instead of hanging it", { timeout: 5_000 }, async () => {
  // #207: the probe for this forward never settled, so neither did the wait,
  // and `sandbox up` exited mid-run with its containers left in Created.
  const port = await freePort();
  const srv = net.createServer((sock) => sock.on("data", () => sock.destroy()));
  open.push(srv);
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  srv.unref();
  await registry([port]);

  await assert.rejects(() => waitForForwards(300, 50), { code: "FORWARDS_NEVER_READY" });
});

test("no forwards in the registry is not something to wait for", async () => {
  await registry([]);
  await waitForForwards(200, 50);
});
