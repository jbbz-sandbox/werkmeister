// SW-387: fetchFresh rests on undici honouring a caller-set `connection: close`.
// If a Node upgrade drops that header, the daemon tests flake again only on a loaded host.

import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { fetchFresh } from "./fixtures.mjs";

test("fetchFresh opens a new connection for every request", async () => {
  let connections = 0;
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("connection", () => connections++);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    for (let i = 0; i < 3; i++) await (await fetchFresh(url)).text();
    assert.equal(connections, 3);
  } finally {
    server.close();
  }
});
