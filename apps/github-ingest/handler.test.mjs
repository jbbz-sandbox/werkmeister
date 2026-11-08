// SW-583: the Lambda is the public trust boundary. Only a correctly signed, selected event reaches the queue.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeHandler } from "./lambda/handler.mjs";

const SECRET = "0123456789abcdef0123456789";
const sign = (body, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const PAYLOAD = JSON.stringify({ action: "opened", repository: { full_name: "o/app" } });

function setup({ send } = {}) {
  const sent = [];
  const handler = makeHandler({
    secret: SECRET,
    send:
      send ??
      (async (b) => {
        sent.push(JSON.parse(b));
      }),
  });
  const call = (body, headers = {}, extra = {}) =>
    handler({
      body,
      headers: { "x-github-event": "pull_request", "x-github-delivery": "d1", ...headers },
      ...extra,
    });
  return { sent, call };
}

test("a signed pull_request is queued as {delivery, event, action, repo}: 202", async () => {
  const { sent, call } = setup();
  const r = await call(PAYLOAD, { "x-hub-signature-256": sign(PAYLOAD) });
  assert.equal(r.statusCode, 202);
  assert.deepEqual(sent, [
    { delivery: "d1", event: "pull_request", action: "opened", repo: "o/app" },
  ]);
});

test("missing, malformed or wrong signatures are 401 and never queued", async () => {
  const { sent, call } = setup();
  for (const sig of [
    undefined,
    "",
    "sha1=abc",
    "sha256=xyz",
    sign(PAYLOAD).toUpperCase(),
    sign(PAYLOAD, "another-secret-another-secret"),
    sign(`${PAYLOAD} `),
  ]) {
    const headers = sig === undefined ? {} : { "x-hub-signature-256": sig };
    assert.equal((await call(PAYLOAD, headers)).statusCode, 401, String(sig));
  }
  assert.deepEqual(sent, []);
});

test("a base64 body (Function URL encoding) is checked over its decoded bytes", async () => {
  const { sent, call } = setup();
  const r = await call(
    Buffer.from(PAYLOAD).toString("base64"),
    { "x-hub-signature-256": sign(PAYLOAD) },
    { isBase64Encoded: true },
  );
  assert.equal(r.statusCode, 202);
  assert.equal(sent.length, 1);
});

test("unselected events and payloads without a repo are 204, not queued", async () => {
  const { sent, call } = setup();
  for (const event of ["ping", "push", "installation"])
    assert.equal(
      (await call(PAYLOAD, { "x-github-event": event, "x-hub-signature-256": sign(PAYLOAD) }))
        .statusCode,
      204,
    );
  const noRepo = JSON.stringify({ action: "created" });
  assert.equal((await call(noRepo, { "x-hub-signature-256": sign(noRepo) })).statusCode, 204);
  assert.deepEqual(sent, []);
});

test("an empty secret fails closed: 500 even for a request signed with the empty key", async () => {
  const sent = [];
  const handler = makeHandler({ secret: "", send: async (b) => sent.push(b) });
  const r = await handler({
    body: PAYLOAD,
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(PAYLOAD, "") },
  });
  assert.equal(r.statusCode, 500);
  assert.deepEqual(sent, []);
});

test("a failed send is 500, so GitHub records the delivery as failed", async () => {
  const { call } = setup({
    send: async () => {
      throw new Error("sqs down");
    },
  });
  assert.equal((await call(PAYLOAD, { "x-hub-signature-256": sign(PAYLOAD) })).statusCode, 500);
});
