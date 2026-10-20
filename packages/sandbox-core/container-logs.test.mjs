// The log source behind `sandbox logs`, the MCP logs tool and the VS Code pane
// (SW-61). The Engine is a tiny fake HTTP daemon, so dockerode, the demuxer and
// the abort wiring are the real ones. Only the daemon is faked.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";

const PROJECT = "sandbox-demo";

/** One Engine multiplex frame: stream type, three zero bytes, big-endian length, payload. */
function frame(type, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const containers = {
  // A default compose name: the prefix drops the project.
  "sandbox-demo-api-1": {
    service: "api",
    tty: false,
    backlog: [frame(1, "up\n"), frame(2, "warn\n")],
  },
  // A custom container_name, as sandbox's template writes: compose keeps it whole.
  "demo-web": { service: "web", tty: true, backlog: [Buffer.from("ready\r\n")] },
  // Not running when a tail starts; a test starts it mid-follow.
  "sandbox-demo-late-1": {
    service: "late",
    tty: false,
    backlog: [frame(1, "hello\n")],
    hidden: true,
  },
};

const logRequests = [];
const eventStreams = [];
let openFollows = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/containers/json") {
    const labels = JSON.parse(url.searchParams.get("filters")).label;
    const svc = labels.find((l) => l.startsWith("com.docker.compose.service="))?.split("=")[1];
    const list = Object.entries(containers)
      .filter(([, c]) => !c.hidden && (!svc || c.service === svc))
      .map(([name, c]) => ({
        Id: name,
        Names: [`/${name}`],
        State: "running",
        Status: "Up 1 minute",
        Ports: [],
        Labels: {
          "com.docker.compose.project": PROJECT,
          "com.docker.compose.service": c.service,
          "com.docker.compose.container-number": "1",
        },
      }));
    return res.end(JSON.stringify(list));
  }
  const inspect = /^\/containers\/([^/]+)\/json$/.exec(url.pathname);
  if (inspect) {
    return res.end(JSON.stringify({ Config: { Tty: containers[inspect[1]].tty } }));
  }
  const logs = /^\/containers\/([^/]+)\/logs$/.exec(url.pathname);
  if (logs) {
    logRequests.push({ name: logs[1], query: Object.fromEntries(url.searchParams) });
    res.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" });
    for (const chunk of containers[logs[1]].backlog) res.write(chunk);
    if (url.searchParams.get("follow") === "true") {
      openFollows++;
      req.socket.once("close", () => openFollows--);
      return; // held open, as the daemon does, until the client goes away
    }
    return res.end();
  }
  if (url.pathname === "/events") {
    // Headers now, body never: the daemon's shape for an idle event stream.
    res.writeHead(200).flushHeaders();
    eventStreams.push(res);
    return;
  }
  res.writeHead(404).end();
});

let mod;
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Before the first docker() call: the client caches its endpoint.
  process.env.DOCKER_HOST = `tcp://127.0.0.1:${server.address().port}`;
  mod = await import("./dist/docker.js");
});
after(() => server.close());

function collect() {
  const lines = [];
  return { lines, onLine: (line, stream) => lines.push([stream, line]) };
}

test("a mixed stream is split into stdout and stderr, and a line across chunks is joined", async () => {
  const raw = new PassThrough();
  const { lines, onLine } = collect();
  const done = mod.pipeLogLines(raw, false, "api-1 | ", onLine);
  raw.write(frame(1, "hello\nwor"));
  raw.write(frame(2, "oops\n"));
  raw.end(frame(1, "ld\ntrailing"));
  await done;
  assert.deepEqual(lines, [
    ["stdout", "api-1 | hello"],
    ["stderr", "api-1 | oops"],
    ["stdout", "api-1 | world"],
    // A final line without a newline still shows, as compose shows it.
    ["stdout", "api-1 | trailing"],
  ]);
});

test("a TTY stream skips the demuxer: a first byte that looks like a header is kept", async () => {
  const raw = new PassThrough();
  const { lines, onLine } = collect();
  const done = mod.pipeLogLines(raw, true, "", onLine);
  // Through the splitter, \x01 plus the next seven bytes would be read as a frame header.
  raw.end(Buffer.from("\u0001abcdefgh\r\nnext\r\n"));
  await done;
  assert.deepEqual(lines, [
    ["stdout", "\u0001abcdefgh"],
    ["stdout", "next"],
  ]);
});

test("the prefix name follows compose: project dropped from a default name, a custom name kept", () => {
  const labels = {
    "com.docker.compose.project": PROJECT,
    "com.docker.compose.service": "api",
    "com.docker.compose.container-number": "1",
  };
  assert.equal(mod.logName({ name: "sandbox-demo-api-1", labels }), "api-1");
  assert.equal(mod.logName({ name: "demo-api", labels }), "demo-api");
});

test("the prefix pads to the widest name, and the colour is stable per name and optional", () => {
  assert.equal(mod.logPrefix("api-1", 8, false), "api-1    | ");
  const coloured = mod.logPrefix("api-1", 8, true);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserts the raw ANSI colour code
  assert.match(coloured, /^\u001b\[3\dmapi-1 {4}\| \u001b\[0m$/);
  assert.equal(mod.logPrefix("api-1", 8, true), coloured);
});

test("follow: false resolves once every container's backlog is out, prefixed and padded", async () => {
  logRequests.length = 0;
  const { lines, onLine } = collect();
  await mod.containerLogs(PROJECT, null, { follow: false, tail: 50, color: false }, onLine);
  assert.deepEqual(
    lines.sort(),
    [
      ["stderr", "api-1    | warn"],
      ["stdout", "api-1    | up"],
      ["stdout", "demo-web | ready"],
    ].sort(),
  );
  for (const r of logRequests) {
    assert.equal(r.query.tail, "50");
    assert.notEqual(r.query.follow, "true");
  }
});

test("an unknown service is one line, not an empty stream", async () => {
  const { lines, onLine } = collect();
  await mod.containerLogs(PROJECT, "nope", { follow: false, tail: 10, color: false }, onLine);
  assert.deepEqual(lines, [["stderr", "no such service: nope"]]);
});

test("aborting a follow closes every container stream", async () => {
  const controller = new AbortController();
  const { lines, onLine } = collect();
  const done = mod.containerLogs(
    PROJECT,
    null,
    { follow: true, tail: 10, color: false, signal: controller.signal },
    onLine,
  );
  // Both backlogs out means both streams are open.
  while (lines.length < 3) await new Promise((r) => setTimeout(r, 10));
  assert.equal(openFollows, 2);
  controller.abort();
  await done;
  // The socket close lands on the server a tick after the client's abort.
  for (let i = 0; openFollows > 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(openFollows, 0);
});

test("a container that starts during a follow is attached, from its start on", async () => {
  logRequests.length = 0;
  const controller = new AbortController();
  const { lines, onLine } = collect();
  const done = mod.containerLogs(
    PROJECT,
    null,
    { follow: true, tail: 10, color: false, signal: controller.signal },
    onLine,
  );
  while (lines.length < 3) await new Promise((r) => setTimeout(r, 10));
  const attrs = {
    name: "sandbox-demo-late-1",
    "com.docker.compose.project": PROJECT,
    "com.docker.compose.service": "late",
    "com.docker.compose.container-number": "1",
  };
  // One event split across two chunks, as a socket may deliver it.
  const event = `${JSON.stringify({ Type: "container", Action: "start", Actor: { Attributes: attrs }, time: 1700000000 })}\n`;
  eventStreams.at(-1).write(event.slice(0, 20));
  eventStreams.at(-1).write(event.slice(20));
  while (lines.length < 4) await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await done;
  assert.deepEqual(lines.at(-1), ["stdout", "late-1   | hello"]);
  const late = logRequests.find((r) => r.name === "sandbox-demo-late-1");
  // From the start event on, so a restart doesn't replay the backlog.
  assert.equal(late.query.since, "1700000000");
  assert.equal(late.query.tail, undefined);
});
