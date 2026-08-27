// The dead-forward case is why these probes exist: a stale `kubectl
// port-forward` accepts the TCP connection and never replies, so anything that
// stops at "connected" reports a dead datastore as healthy. The silent-server
// test below is that failure, and it is the one that must stay red if someone
// simplifies checkWireHealth back into a connect check.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { checkWireHealth } from "./dist/sandbox.js";

/** Listen on an ephemeral port. `reply` of null = accept and stay silent. */
function fakeForward(reply) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on("data", () => {
        if (reply !== null) sock.write(reply);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

async function probe(reply, kind) {
  const srv = await fakeForward(reply);
  try {
    return await checkWireHealth(srv.port, kind, 300);
  } finally {
    srv.close();
  }
}

test("redis answering PING is healthy", async () => {
  assert.equal((await probe("+PONG\r\n", "redis")).ok, true);
});

test("postgres answering the SSLRequest is healthy", async () => {
  assert.equal((await probe("N", "postgres")).ok, true);
  assert.equal((await probe("S", "postgres")).ok, true);
});

test("a forward that accepts and never replies is unhealthy", async () => {
  for (const kind of ["redis", "postgres"]) {
    const r = await probe(null, kind);
    assert.equal(r.ok, false, `${kind} silent`);
    assert.match(r.detail, /timeout/);
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
