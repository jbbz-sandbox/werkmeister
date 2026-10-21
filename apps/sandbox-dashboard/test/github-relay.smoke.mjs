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
assert.equal(
  relayEventOf(msg("pull_request", prBody, "sha256=" + "0".repeat(64)), SECRET),
  null,
);
assert.equal(relayEventOf({ "x-github-event": "pull_request", body: prBody }, SECRET), null);

// SseParser: split frames, multi-line data, comments/event lines ignored
const p = new SseParser();
assert.deepEqual(p.push('event: ready\ndata: {"a"'), []);
assert.deepEqual(p.push(':1}\n\ndata: x\ndata: y\n\n: keepalive\n\n'), ['{"a":1}', "x\ny"]);

console.log("github-relay smoke: ok");
