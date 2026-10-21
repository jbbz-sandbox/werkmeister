// Smoke test for lib/github-relay: GitHub signature check, event filter, SSE parsing.
//   npm run build && node test/github-relay.smoke.mjs
import assert from "node:assert";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { verifySignature, relayEventOf, SseParser } = await import(
  path.join(pkgRoot, "dist/lib/github-relay.js")
);

const SECRET = "s3cret";
const sign = (body) => "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
const prBody = {
  action: "closed",
  pull_request: { merged: true },
  repository: { full_name: "jbbz-sandbox/sandbox" },
};
const msg = (event, body, sig = sign(JSON.stringify(body))) => ({
  "x-github-event": event,
  "x-hub-signature-256": sig,
  body,
});

// verifySignature
assert.equal(verifySignature('{"a":1}', sign('{"a":1}'), SECRET), true);
assert.equal(verifySignature('{"a":1}', sign('{"a":2}'), SECRET), false);
assert.equal(verifySignature('{"a":1}', undefined, SECRET), false);
assert.equal(verifySignature('{"a":1}', "sha256=zz", SECRET), false);

// relayEventOf
assert.deepEqual(relayEventOf(msg("pull_request", prBody), SECRET), {
  event: "pull_request",
  repo: "jbbz-sandbox/sandbox",
});
assert.deepEqual(relayEventOf(msg("release", { ...prBody, action: "published" }), SECRET), {
  event: "release",
  repo: "jbbz-sandbox/sandbox",
});
assert.equal(relayEventOf(msg("pull_request", { ...prBody, action: "opened" }), SECRET), null);
assert.equal(relayEventOf(msg("release", { ...prBody, action: "created" }), SECRET), null);
assert.equal(relayEventOf(msg("ping", prBody), SECRET), null);
assert.equal(relayEventOf(msg("pull_request", prBody, "sha256=" + "0".repeat(64)), SECRET), null);
assert.equal(relayEventOf({ "x-github-event": "pull_request", body: prBody }, SECRET), null);

// SseParser: split frames, multi-line data, comments/event lines ignored
const p = new SseParser();
assert.deepEqual(p.push('event: ready\ndata: {"a"'), []);
assert.deepEqual(p.push(":1}\n\ndata: x\ndata: y\n\n: keepalive\n\n"), ['{"a":1}', "x\ny"]);

// startGithubRelay: a fake fetch hands back a stream the test pushes chunks into.
const { startGithubRelay } = await import(path.join(pkgRoot, "dist/lib/github-relay.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeStream = () => {
  let ctl;
  const readable = new ReadableStream({ start: (c) => (ctl = c) });
  return { readable, push: (t) => ctl.enqueue(new TextEncoder().encode(t)) };
};

// debounce: three signed events in one burst → onEvents called once with all three
const calls = [];
const s1 = fakeStream();
const relay = startGithubRelay({
  url: "https://smee.io/x",
  secret: SECRET,
  debounceMs: 20,
  fetch: async () => new Response(s1.readable),
  onEvents: async (ev) => {
    calls.push(ev);
  },
  log: () => {},
});
for (let i = 0; i < 3; i++) s1.push(`data: ${JSON.stringify(msg("pull_request", prBody))}\n\n`);
s1.push(`data: ${JSON.stringify(msg("ping", prBody))}\n\n`);
s1.push("data: not json\n\n");
await sleep(60);
assert.equal(calls.length, 1);
assert.equal(calls[0].length, 3);
relay.stop();

// reconnect: first fetch rejects, second stream delivers → onEvents runs
let n = 0;
const s2 = fakeStream();
const got = [];
const r2 = startGithubRelay({
  url: "https://smee.io/x",
  secret: SECRET,
  debounceMs: 5,
  backoffMs: [10],
  fetch: async () => {
    if (n++ === 0) throw new Error("down");
    return new Response(s2.readable);
  },
  onEvents: async (ev) => {
    got.push(...ev);
  },
  log: () => {},
});
await sleep(30);
s2.push(`data: ${JSON.stringify(msg("release", { ...prBody, action: "published" }))}\n\n`);
await sleep(30);
assert.equal(n, 2);
assert.deepEqual(got, [{ event: "release", repo: "jbbz-sandbox/sandbox" }]);
r2.stop();

console.log("github-relay smoke: ok");
