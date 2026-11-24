// The command's fail() called process.exit(1). In-process that kills the host
// server, which is why no server could call this route without spawning the CLI.
// Every rejection is now a coded SandboxError.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { SandboxError } from "../dist/errors.js";
import {
  dockerDaemonName,
  leaveFeatureIntercepts,
  leaveIntercept,
  listIntercepts,
  portOpen,
  startIntercept,
} from "../dist/telepresence.js";
import { withSandboxHome } from "./fixtures.mjs";

// These runners are fakes; under with-temp-home the SW-1074 guard would skip them before they run.
let tempHome;
before(() => {
  tempHome = process.env.WERKMEISTER_TEMP_HOME;
  delete process.env.WERKMEISTER_TEMP_HOME;
});
after(() => {
  if (tempHome !== undefined) process.env.WERKMEISTER_TEMP_HOME = tempHome;
});

const base = { feature: "demo", localServices: ["backend"] };

test("a service the workspace does not run locally raises NOT_LOCAL", async () => {
  const err = await startIntercept({
    ...base,
    service: "frontend",
    localServices: ["backend"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof SandboxError, `expected SandboxError, got ${err}`);
  assert.equal(err.code, "NOT_LOCAL");
  // The message is CLI output and must not drift.
  assert.equal(
    err.message,
    "'frontend' is not a local service of this workspace (SERVICES=backend). " +
      "Add it to workspace.yml services and rerun `werkmeister workspace init`.",
  );
});

test("an empty SERVICES list still names the empty set", async () => {
  const err = await startIntercept({ ...base, service: "nope", localServices: [] }).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.code, "NOT_LOCAL");
  assert.match(err.message, /SERVICES=\(none\)/);
});

test("startIntercept never calls process.exit", async () => {
  // If it did, this test file would die here rather than report a failure.
  await startIntercept({ ...base, service: "nope", localServices: [] }).catch(() => {});
  assert.ok(true);
});

test("leaveIntercept validates the service the same way", async () => {
  const err = await leaveIntercept({
    ...base,
    service: "frontend",
    localServices: ["backend"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof SandboxError, `expected SandboxError, got ${err}`);
  assert.equal(err.code, "NOT_LOCAL");
});

test("portOpen resolves false for a closed port rather than hanging", async () => {
  assert.equal(await portOpen(1, 200), false);
});

// SW-12: absent, disconnected and connected are three different answers.
function fakeTelepresence(status, list = [0, "[]"]) {
  const calls = [];
  const runner = (cmd) => {
    calls.push(cmd[1]);
    return cmd[1] === "status" ? status : list;
  };
  return { runner, calls };
}
const CONNECTED = [0, JSON.stringify({ daemon: { status: "Connected", namespace: "default" } })];
const ACTIVE = JSON.stringify([
  { name: "frontend", intercept_info: [{ spec: { header_filters: { "x-feature": "ab" } } }] },
]);

test("listIntercepts: a missing binary is not installed, and list never runs", async () => {
  const t = fakeTelepresence([127, "telepresence: command not found"]);
  const s = await listIntercepts(t.runner);
  assert.deepEqual(
    [s.installed, s.available, s.namespace, s.intercepts.size],
    [false, false, null, 0],
  );
  assert.deepEqual(t.calls, ["status"]);
});

test("listIntercepts: disconnected is installed but unavailable, and list never runs", async () => {
  const t = fakeTelepresence([
    1,
    '{"error":"root daemon: telepresence root daemon is not running"}',
  ]);
  const s = await listIntercepts(t.runner);
  assert.deepEqual(
    [s.installed, s.available, s.namespace, s.intercepts.size],
    [true, false, null, 0],
  );
  assert.deepEqual(t.calls, ["status"]);
});

test("listIntercepts: connected reads the namespace and the intercepts", async () => {
  const t = fakeTelepresence(CONNECTED, [0, ACTIVE]);
  const s = await listIntercepts(t.runner);
  assert.deepEqual([s.installed, s.available, s.namespace], [true, true, "default"]);
  assert.deepEqual([...s.intercepts], [["frontend", "ab"]]);
  assert.deepEqual(t.calls, ["status", "list"]);
});

test("listIntercepts: connected but list failing stays installed, unavailable", async () => {
  const s = await listIntercepts(fakeTelepresence(CONNECTED, [1, "boom"]).runner);
  assert.deepEqual(
    [s.installed, s.available, s.namespace, s.intercepts.size],
    [true, false, "default", 0],
  );
});

test("listIntercepts: with a host daemon beside the docker one, reads the connected one", async () => {
  const MULTI =
    "multiple daemons are running, please select orbstack-default or orbstack-default-cn using the --use <match> flag";
  const calls = [];
  const runner = (cmd) => {
    calls.push(cmd.slice(1).join(" "));
    const use = cmd[cmd.indexOf("--use") + 1];
    if (cmd[1] === "list") return [0, ACTIVE];
    if (!cmd.includes("--use")) return [1, MULTI];
    return use === "orbstack-default-cn"
      ? CONNECTED
      : [1, '{"error":"root daemon is not running"}'];
  };
  const s = await listIntercepts(runner);
  assert.deepEqual([s.installed, s.available, s.namespace], [true, true, "default"]);
  assert.equal(calls.at(-1), "list -i --format json --use orbstack-default-cn");
});

test("dockerDaemonName is the container name connect --docker uses", () => {
  assert.equal(dockerDaemonName("orbstack", "default"), "orbstack-default-cn");
});

// SW-920: `overrides.telepresence: false` starts no telepresence process on its own.
const neverRun = () => {
  throw new Error("telepresence ran while overrides.telepresence is false");
};
const telepresenceOff = (fn) =>
  withSandboxHome(fn, { config: "overrides:\n  telepresence: false\n" });

test("telepresence off: listIntercepts is not installed and runs nothing (SW-920)", async () => {
  await telepresenceOff(async () => {
    const s = await listIntercepts(neverRun);
    assert.deepEqual([s.installed, s.available, s.intercepts.size], [false, false, 0]);
  });
});

test("telepresence off: feature down's leave runs nothing (SW-920)", async () => {
  await telepresenceOff(() => assert.deepEqual(leaveFeatureIntercepts("demo", neverRun), []));
});

test("telepresence off: startIntercept is TELEPRESENCE_DISABLED and names the config line (SW-920)", async () => {
  await telepresenceOff(async () => {
    const err = await startIntercept({ ...base, service: "backend" }).then(
      () => null,
      (e) => e,
    );
    assert.equal(err?.code, "TELEPRESENCE_DISABLED");
    assert.match(err.message, /telepresence: false/);
  });
});

test("telepresence: true keeps intercepts on (SW-920)", async () => {
  await withSandboxHome(
    async () => {
      const t = fakeTelepresence([127, "telepresence: command not found"]);
      await listIntercepts(t.runner);
      assert.deepEqual(t.calls, ["status"]);
    },
    { config: "overrides:\n  telepresence: true\n" },
  );
});
