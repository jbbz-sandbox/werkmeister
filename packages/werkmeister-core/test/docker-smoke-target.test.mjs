// SW-663: docker.smoke.mjs took the first container the host listed, so it wrote
// into and exec'd in other workspaces' containers, and failed with HTTP 409 when
// that container was paused. A fake Engine on a unix socket lists only foreign
// containers and refuses one step per case: the smoke must leave the foreign
// containers alone, clean up its own, and SKIP with that step's line (exit 0).
// The full round-trip runs against the real daemon in `pnpm test`'s smoke pass.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dir = fs.mkdtempSync(path.join(tmpdir(), "smoke-target-"));
const sock = path.join(dir, "docker.sock");
const OWN = "smokeown0001";

const foreign = [
  { Id: "otherpaused0001", Names: ["/sw-580-x-werkmeister-vscode"], State: "paused" },
  { Id: "otherrunning001", Names: ["/sw-751-x-werkmeister-core"], State: "running" },
].map((c) => ({
  ...c,
  Labels: { "com.docker.compose.project": "werkmeister-other" },
  Status: c.State === "paused" ? "Up 1 hour (Paused)" : "Up 1 hour",
}));

let refuse; // the one step the engine refuses: "image+pull" | "create" | "start"
let calls;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://engine");
  const p = url.pathname.replace(/^\/v[\d.]+/, "");
  calls.push(`${req.method} ${p}`);
  req.resume();
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (p === "/_ping") return res.writeHead(200).end("OK");
  if (p === "/containers/json") return json(200, foreign);
  if (/^\/images\/.+\/json$/.test(p))
    return refuse === "image+pull" ? json(404, { message: "no such image" }) : json(200, {});
  if (p === "/images/create") return json(500, { message: "pull refused" });
  if (p === "/containers/create")
    return refuse === "create" ? json(500, { message: "create refused" }) : json(201, { Id: OWN });
  if (p === `/containers/${OWN}/start`) return json(500, { message: "start refused" });
  if (req.method === "DELETE" && p === `/containers/${OWN}`) return res.writeHead(204).end();
  const target = foreign.find((c) => p.includes(c.Id));
  if (target?.State === "paused") return json(409, { message: `container ${target.Id} is paused` });
  return json(404, { message: "not implemented by this fake engine" });
});
await new Promise((r) => server.listen(sock, r));
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function smoke(dockerHost) {
  calls = [];
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "docker.smoke.mjs")], {
    env: { ...process.env, DOCKER_HOST: dockerHost, WERKMEISTER_DOCKER_ENGINE: "1" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  const touched = calls.filter((c) => foreign.some((f) => c.includes(f.Id)));
  assert.deepEqual(touched, [], `the smoke reached foreign containers:\n${out}`);
  assert.equal(code, 0, `the smoke exited ${code}:\n${out}`);
  return out;
}

test("no reachable daemon: SKIP", async () => {
  const out = await smoke(`unix://${path.join(dir, "absent.sock")}`);
  assert.match(out, /docker\.smoke SKIPPED \(no reachable daemon\)/);
});

test("image missing and the pull refused: SKIP, no container created", async () => {
  refuse = "image+pull";
  const out = await smoke(`unix://${sock}`);
  assert.match(out, /docker\.smoke SKIPPED \(no smoke image: .*pull refused/);
  assert.ok(!calls.some((c) => c.includes("/containers/create")), calls.join("\n"));
});

test("create refused: SKIP, never falls back to a listed container", async () => {
  refuse = "create";
  const out = await smoke(`unix://${sock}`);
  assert.match(out, /docker\.smoke SKIPPED \(could not start a smoke container: create refused\)/);
  assert.ok(!calls.some((c) => c.startsWith("GET /containers/json")), calls.join("\n"));
});

test("start refused: SKIP, and its own container is removed", async () => {
  refuse = "start";
  const out = await smoke(`unix://${sock}`);
  assert.match(out, /docker\.smoke SKIPPED \(could not start a smoke container: start refused\)/);
  assert.ok(calls.includes(`DELETE /containers/${OWN}`), calls.join("\n"));
});
