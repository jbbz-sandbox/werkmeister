// The dead-forward case is why these probes exist: a stale `kubectl
// port-forward` accepts the TCP connection and never replies, so anything that
// stops at "connected" reports a dead datastore as healthy. The silent-server
// test below is that failure, and it is the one that must stay red if someone
// simplifies checkWireHealth back into a connect check.

import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import { checkForwardHealth, checkWireHealth } from "./dist/k8s.js";

/** Listen on an ephemeral port. `reply` of null = accept and stay silent; `delayMs` holds the reply back. */
function fakeForward(reply, delayMs = 0) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on("data", () => {
        if (reply !== null) setTimeout(() => sock.write(reply), delayMs);
      });
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({ port: srv.address().port, close: () => srv.close() }),
    );
  });
}

// A reply ends the probe at once, so the limit only matters on a loaded host (SW-299).
const LOAD_TOLERANT_MS = 30_000;

async function probe(reply, kind, delayMs = 0, timeoutMs = LOAD_TOLERANT_MS) {
  const srv = await fakeForward(reply, delayMs);
  try {
    return await checkWireHealth(srv.port, kind, timeoutMs);
  } finally {
    srv.close();
  }
}

test("redis answering PING is healthy", async () => {
  assert.equal((await probe("+PONG\r\n", "redis")).ok, true);
});

// SW-299: a loaded host can delay the reply past a short probe limit; that is load, not a dead forward.
test("a slow reply is still healthy", async () => {
  assert.equal((await probe("+PONG\r\n", "redis", 500)).ok, true);
  assert.equal((await probe("N", "postgres", 500)).ok, true);
});

test("postgres answering the SSLRequest is healthy", async () => {
  assert.equal((await probe("N", "postgres")).ok, true);
  assert.equal((await probe("S", "postgres")).ok, true);
});

test("a forward that accepts and never replies is unhealthy", async () => {
  for (const kind of ["redis", "postgres"]) {
    const r = await probe(null, kind, 0, 300); // waits out the whole limit by design
    assert.equal(r.ok, false, `${kind} silent`);
    assert.match(r.detail, /timeout/);
  }
});

// #207: Docker's port proxy, or a forward mid-reconnect, accepts the connection
// and hangs up without a byte. That fires none of data/timeout/error, so the
// probe never settled and `sandbox up` exited on an unsettled top-level await.
// The per-test timeout is the guard, and unref() keeps the server from holding
// the file open past it: a pending probe fails here instead of hanging the run.
test("a forward that hangs up without replying is unhealthy, not pending", {
  timeout: 2_000,
}, async () => {
  const srv = net.createServer((sock) => sock.on("data", () => sock.destroy()));
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  srv.unref();
  try {
    for (const kind of ["redis", "postgres"]) {
      const r = await checkWireHealth(srv.address().port, kind, 1_000);
      assert.equal(r.ok, false, `${kind} hung up`);
    }
  } finally {
    srv.close();
  }
});

test("a reply from something else on the port is unhealthy", async () => {
  assert.equal((await probe("HTTP/1.1 200 OK\r\n", "redis")).ok, false);
  assert.equal((await probe("X", "postgres")).ok, false);
});

test("nothing listening is unhealthy", async () => {
  const srv = await fakeForward("+PONG\r\n");
  srv.close();
  assert.equal((await checkWireHealth(srv.port, "redis", 300)).ok, false);
});

// The bug these cover: `sandbox status` had its own probe that treated any
// non-empty health_endpoint as a URL path, so `redis` became an HTTP GET
// /redis at a Redis port and every healthy datastore forward read dead — for
// the whole time #24's protocol probes were supposedly in place. Selection is
// the part that was wrong, not the probes, so selection is what is asserted.
test("a wire-probe name selects the wire probe, not an HTTP path", async () => {
  const srv = await fakeForward("+PONG\r\n");
  try {
    assert.equal((await checkForwardHealth(srv.port, "redis")).ok, true);
  } finally {
    srv.close();
  }
});

test("an unknown probe name fails instead of falling back to a connect", async () => {
  // A connect-only fallback is what cannot see a dead forward, so an
  // unrecognised name must not quietly get one.
  const srv = await fakeForward(null);
  try {
    const r = await checkForwardHealth(srv.port, "mongodb");
    assert.equal(r.ok, false);
    assert.match(r.detail, /unknown probe/);
  } finally {
    srv.close();
  }
});

test("a blank health_endpoint is TCP-only", async () => {
  const srv = await fakeForward(null);
  try {
    assert.equal((await checkForwardHealth(srv.port, "")).ok, true);
  } finally {
    srv.close();
  }
});
