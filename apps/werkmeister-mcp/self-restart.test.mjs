// SW-306: the daemon exits for a new build only once no call and no queued feature is in flight.
// No launchd: the last test spawns the built daemon with the label launchd would set and waits for its exit.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { queuePath } from "werkmeister-core/scheduler_state";

import { restartGuard } from "./dist/lib/self_restart.js";

function setup({ queued = 0, exit = true } = {}) {
  const state = { build: "1.0.0 @ a", queued, exits: 0 };
  const guard = restartGuard({
    entry: "/x/dist/main.js",
    build: () => state.build,
    queued: () => state.queued,
    exit: exit ? () => state.exits++ : undefined,
  });
  return { state, guard };
}

test("an unchanged build never exits, and status reports the loaded build", () => {
  const { state, guard } = setup();
  guard.check();
  assert.equal(state.exits, 0);
  assert.deepEqual(guard.status(), {
    loaded: "1.0.0 @ a",
    onDisk: "1.0.0 @ a",
    stale: false,
    inFlight: 0,
    queued: 0,
    restartPending: false,
  });
});

test("a new build waits for the call in flight, then exits once", async () => {
  const { state, guard } = setup();
  let finish;
  const call = guard.track(() => new Promise((r) => (finish = r)));
  state.build = "1.0.0 @ b";
  guard.check();
  assert.equal(state.exits, 0);
  assert.equal(guard.status().inFlight, 1);
  assert.equal(guard.status().stale, true);
  finish("done");
  assert.equal(await call, "done");
  assert.equal(state.exits, 1);
  guard.check();
  assert.equal(state.exits, 1);
});

test("a feature waiting in the queue keeps the old daemon until the queue clears", () => {
  const { state, guard } = setup({ queued: 1 });
  state.build = "1.0.1 @ a";
  guard.check();
  assert.equal(state.exits, 0);
  assert.equal(guard.status().restartPending, true);
  state.queued = 0;
  guard.check();
  assert.equal(state.exits, 1);
});

test("a failed call still counts down, so it cannot pin the old build", async () => {
  const { state, guard } = setup();
  state.build = "1.0.0 @ b";
  await assert.rejects(
    guard.track(async () => {
      guard.check();
      assert.equal(state.exits, 0);
      throw new Error("tool failed");
    }),
  );
  assert.equal(state.exits, 1);
});

test("an unreadable entry mid-rebuild is not a change", () => {
  const { state, guard } = setup();
  state.build = null;
  guard.check();
  assert.equal(state.exits, 0);
  assert.equal(guard.status().stale, false);
});

test("without a supervisor it reports stale and never exits", () => {
  const { state, guard } = setup({ exit: false });
  state.build = "1.0.0 @ b";
  guard.check();
  assert.equal(guard.status().stale, true);
  assert.equal(guard.status().restartPending, false);
  assert.equal(state.exits, 0);
});

test("the built daemon under launchd's label reports its build, holds for a queued feature, then exits 0", async () => {
  // A private copy of dist to touch without racing other tests; under node_modules so bare imports still resolve.
  const dist = path.join(import.meta.dirname, "dist");
  const copy = fs.mkdtempSync(path.join(import.meta.dirname, "node_modules", ".self-restart-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-self-restart-"));
  const home = path.join(tmp, "home");
  fs.cpSync(dist, path.join(copy, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(copy, "package.json"),
    JSON.stringify({ type: "module", version: "9.9.9" }),
  );
  const entry = path.join(copy, "dist", "main.js");
  fs.utimesSync(entry, new Date("2026-10-31T10:16:00Z"), new Date("2026-10-31T10:16:00Z"));
  fs.mkdirSync(home);
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const queue = queuePath();
  process.env.HOME = prevHome;
  fs.mkdirSync(path.dirname(queue), { recursive: true });
  fs.writeFileSync(queue, JSON.stringify(["waiting-feature"]));

  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const server = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      HOST: "127.0.0.1",
      XPC_SERVICE_NAME: "com.werkmeister.daemon",
      WERKMEISTER_FIXTURE: "1",
    },
  });
  const exited = new Promise((resolve) => server.on("exit", (code) => resolve(code)));
  try {
    let stderr = "";
    server.stderr.on("data", (d) => (stderr += d));
    for (let i = 0; !stderr.includes("listening"); i++) {
      assert.ok(i < 600, `server never listened:\n${stderr}`);
      await sleep(100);
    }
    const token = fs.readFileSync(path.join(home, ".werkmeister", "mcp-token"), "utf8").trim();
    const status = (build) =>
      fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(build ? { "x-werkmeister-build": build } : {}),
        },
      });

    const before = await status();
    assert.equal(before.headers.get("x-werkmeister-build"), "9.9.9 @ 2026-10-31T10:16:00Z");
    assert.deepEqual(await before.json(), {
      pid: server.pid,
      loaded: "9.9.9 @ 2026-10-31T10:16:00Z",
      onDisk: "9.9.9 @ 2026-10-31T10:16:00Z",
      stale: false,
      inFlight: 0,
      queued: 1,
      restartPending: false,
    });

    fs.utimesSync(entry, new Date("2026-11-01T21:54:00Z"), new Date("2026-11-01T21:54:00Z"));
    // The cue is checked after its own response, so the next request sees the result.
    await (await status("9.9.9 @ 2026-11-01T21:54:00Z")).text();
    const held = await (await status()).json();
    assert.equal(held.stale, true);
    assert.equal(held.restartPending, true);
    assert.equal(held.onDisk, "9.9.9 @ 2026-11-01T21:54:00Z");
    await sleep(300);
    assert.equal(server.exitCode, null, "exited with a feature still queued");

    fs.writeFileSync(queue, "[]");
    await status("9.9.9 @ 2026-11-01T21:54:00Z").catch(() => {});
    const code = await Promise.race([exited, sleep(10_000).then(() => "timeout")]);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /build changed .* exiting to restart/);
  } finally {
    server.kill("SIGKILL");
    fs.rmSync(copy, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
