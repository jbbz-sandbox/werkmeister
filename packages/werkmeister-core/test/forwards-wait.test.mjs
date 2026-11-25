// `docker compose up -d k8s-forwards` returns when the container runs, not when
// the kubectl tunnels inside it reconnect — a second later, in the case that
// prompted this. Anything needing a datastore that starts in that window dies on
// ECONNREFUSED and surfaces as a compose dependency error naming no forward at
// all. These pin the wait that closes the window: that it actually waits rather
// than probing once, and that giving up says which forwards never came back.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { waitForForwards } from "../dist/k8s.js";

const VARS = ["WERKMEISTER_SERVICES_YAML", "WERKMEISTER_CONFIG_FILE", "WERKMEISTER_ROOT"];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let open = [];

/**
 * A port the OS picks, held until afterEach: a port freed and bound again later is a parallel
 * test's to take in between, which made a dead forward answer (SW-1148).
 */
function hold(onData) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => sock.on("data", () => onData(sock)));
    open.push(srv);
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  });
}

/** `+PONG` passes the redis wire probe. */
const pong = (sock) => sock.write("+PONG\r\n");
/** A forward that is down: it takes the connection and drops it unanswered. */
const hangUp = (sock) => sock.destroy();

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
  process.env.WERKMEISTER_SERVICES_YAML = file;
}

beforeEach(() => {
  for (const v of VARS) delete process.env[v];
});
afterEach(() => {
  for (const s of open) s.close();
  open = [];
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("returns once every forward answers its probe", async () => {
  await registry([await hold(pong), await hold(pong)]);

  await waitForForwards(5_000, 50);
});

test("waits for a forward that is still reconnecting", async () => {
  // The whole point: at the first probe this forward fails, as a tunnel
  // mid-reconnect does. A single-shot check would fail the run here.
  let up = false;
  const port = await hold((sock) => (up ? pong(sock) : hangUp(sock)));
  await registry([port]);

  const late = setTimeout(() => (up = true), 300);
  try {
    await waitForForwards(10_000, 50);
  } finally {
    clearTimeout(late);
  }
});

test("names the forwards that never came back", async () => {
  const [alive, dead] = [await hold(pong), await hold(hangUp)];
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

test("a forward that hangs up without replying fails the wait instead of hanging it", {
  timeout: 5_000,
}, async () => {
  // #207: the probe for this forward never settled, so neither did the wait,
  // and `sandbox up` exited mid-run with its containers left in Created.
  const port = await hold(hangUp);
  open.at(-1).unref();
  await registry([port]);

  await assert.rejects(() => waitForForwards(300, 50), { code: "FORWARDS_NEVER_READY" });
});

test("a dead forward's port stays held for the whole test, so no parallel test can take it (SW-1148)", async () => {
  const port = await hold(hangUp);
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const thief = net.createServer();
        thief.once("error", reject);
        thief.listen(port, "127.0.0.1", () => thief.close(resolve));
      }),
    { code: "EADDRINUSE" },
  );
});

test("no forwards in the registry is not something to wait for", async () => {
  await registry([]);
  await waitForForwards(200, 50);
});
