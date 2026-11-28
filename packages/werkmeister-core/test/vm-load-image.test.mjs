// SW-970: machine setup pulls alpine:3 once on macOS and Windows, so readVmLoad's 4 s cap never
// spends itself on a first pull. docker is the injected runner; nothing here reaches a daemon.

import assert from "node:assert/strict";
import { test } from "node:test";
import { syncVmLoadImage } from "../dist/machine_setup.js";

/** A runner answering `docker image inspect` with *inspectRc* and `docker pull` with *pullRc*. */
function runner(inspectRc, pullRc = 0) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(" "));
    if (argv[1] === "image") return [inspectRc, ""];
    if (argv[1] === "pull") return [pullRc, pullRc ? "net/http: TLS handshake timeout" : ""];
    return [0, ""];
  };
  return { run, calls };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: a missing alpine:3 is pulled; a present one is left alone`, () => {
    const missing = runner(1);
    const [step] = syncVmLoadImage(missing.run, false, platform);
    assert.equal(step.ok, true);
    assert.deepEqual(missing.calls, ["docker image inspect alpine:3", "docker pull alpine:3"]);

    const present = runner(0);
    assert.equal(syncVmLoadImage(present.run, false, platform)[0].ok, true);
    assert.deepEqual(present.calls, ["docker image inspect alpine:3"]);
  });
}

test("a failed pull is an optional warning, not a setup failure", () => {
  const r = runner(1, 1);
  const [step] = syncVmLoadImage(r.run, false, "darwin");
  assert.equal(step.ok, false);
  assert.equal(step.optional, true);
  assert.match(step.detail, /TLS handshake timeout/);
});

test("--check reports a missing image without pulling it", () => {
  const r = runner(1);
  const [step] = syncVmLoadImage(r.run, true, "darwin");
  assert.equal(step.optional, true);
  assert.deepEqual(r.calls, ["docker image inspect alpine:3"]);
});

test("linux reads the host's own load: no step, no docker call", () => {
  const r = runner(1);
  assert.deepEqual(syncVmLoadImage(r.run, false, "linux"), []);
  assert.deepEqual(r.calls, []);
});
