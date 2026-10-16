// Docker-mode argument shapes, pinned because both were established by a live
// run against OrbStack's k8s rather than from the docs:
//
//   * connect needs no --server. 2.31 rewrites the loopback API server address
//     for the containerized daemon itself.
//   * intercept DOES need --address. Its 127.0.0.1 default is the daemon
//     container's own loopback, where the cluster's request dies as
//     {"error":"EOF"} while the local container sits idle on the host.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConnectArgs, buildInterceptArgs, DAEMON_HOST_ADDRESS } from "./dist/telepresence.js";

test("connect adds --docker and nothing else", () => {
  assert.deepEqual(buildConnectArgs("orbstack", "default", true), [
    "telepresence",
    "connect",
    "--docker",
    "--context",
    "orbstack",
    "--namespace",
    "default",
  ]);
  assert.ok(!buildConnectArgs("orbstack", "default", true).includes("--server"));
});

test("intercept points a containerized daemon back at the host", () => {
  const args = buildInterceptArgs("backend", 18080, 80, "feat", true);
  assert.deepEqual(args.slice(-2), ["--address", DAEMON_HOST_ADDRESS]);
  // The rest of the shape is untouched by the mode.
  assert.deepEqual(args.slice(0, -2), buildInterceptArgs("backend", 18080, 80, "feat"));
});

test("host mode keeps the 127.0.0.1 default", () => {
  assert.ok(!buildInterceptArgs("backend", 18080, 80, "feat").includes("--address"));
});
