// SW-583/SW-879: the daemon's ingest loop, driven by a fake EventSource. No AWS, no real pr watch.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as tick } from "node:timers/promises";
import { sqsSource, startGithubIngest } from "./dist/github_ingest.js";

const msg = (delivery, repo = "o/app", handle = delivery) => ({
  ReceiptHandle: handle,
  Body: JSON.stringify({ delivery, event: "issue_comment", action: "created", repo }),
});

/** A queue that hands out each scripted batch once, then waits; `stop()` ends the loop. */
function harness(batches, { watch } = {}) {
  const calls = { removed: [], watched: [], logs: [], slept: [] };
  let n = 0;
  const source = {
    receive: async () => {
      const b = batches[n++];
      if (b instanceof Error) throw b;
      if (b)
        return b.map((m) => ({
          body: m.Body,
          ack: async () => {
            calls.removed.push(m.ReceiptHandle);
          },
        }));
      await tick(5);
      return [];
    },
  };
  const deps = {
    watch:
      watch ??
      (async (opts) => {
        calls.watched.push(opts.repo);
        return { lines: ["ok"] };
      }),
    track: (work) => work(),
    log: (m) => calls.logs.push(m),
    sleep: async (ms) => {
      calls.slept.push(ms);
    },
  };
  const loop = startGithubIngest(source, deps);
  return { calls, loop, done: () => tick(30).then(() => loop.stop()) };
}

test("one message: one pass for its repo, then acked", async () => {
  const h = harness([[msg("d1")]]);
  await h.done();
  assert.deepEqual(h.calls.watched, ["o/app"]);
  assert.deepEqual(h.calls.removed, ["d1"]);
  assert.ok(h.calls.logs.some((l) => l.includes("issue_comment/created on o/app (d1): ok")));
});

test("a delivery id seen before runs no second pass, in the same batch or a later one", async () => {
  const h = harness([
    [msg("d1", "o/app", "h1"), msg("d1", "o/app", "h2")],
    [msg("d1", "o/app", "h3")],
  ]);
  await h.done();
  assert.deepEqual(h.calls.watched, ["o/app"]);
  assert.deepEqual(h.calls.removed.sort(), ["h1", "h2", "h3"]);
});

test("a failed pass leaves its messages for redelivery (the DLQ takes them after N)", async () => {
  const h = harness([[msg("d1")]], {
    watch: async () => {
      throw new Error("gh down");
    },
  });
  await h.done();
  assert.deepEqual(h.calls.removed, []);
  assert.ok(h.calls.logs.some((l) => l.includes("pass failed, left for redelivery: gh down")));
});

test("one pass per repo per batch, every message deleted", async () => {
  const h = harness([[msg("d1"), msg("d2", "O/App"), msg("d3"), msg("d4", "o/lib")]]);
  await h.done();
  assert.deepEqual(h.calls.watched, ["o/app", "o/lib"]);
  assert.deepEqual(h.calls.removed.sort(), ["d1", "d2", "d3", "d4"]);
});

test("receive errors back off 5, 10, 20 s… capped at 300 s, and reset after a success", async () => {
  const err = new Error("offline");
  const h = harness([err, err, err, err, err, err, err, [], err]);
  await h.done();
  assert.deepEqual(h.calls.slept, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 5000]);
  assert.ok(h.calls.logs[0].includes("receive failed: offline; retry in 5s"));
});

test("a malformed body is deleted and logged, never passed on", async () => {
  const h = harness([[{ ReceiptHandle: "bad", Body: "{nope" }]]);
  await h.done();
  assert.deepEqual(h.calls.watched, []);
  assert.deepEqual(h.calls.removed, ["bad"]);
  assert.ok(h.calls.logs.some((l) => l.includes("dropped a malformed message")));
});

test("sqsSource: 20 s long poll of up to 10, skips handle-less messages, ack deletes", async () => {
  const sent = [];
  const client = {
    send: async (cmd) => {
      sent.push([cmd.constructor.name, cmd.input]);
      return { Messages: [{ Body: "b1", ReceiptHandle: "h1" }, { Body: "b2" }] };
    },
  };
  const cfg = { queueUrl: "https://sqs/q", region: "r", accessKeyId: "a", secretAccessKey: "s" };
  const msgs = await (await sqsSource(cfg, client)).receive();
  assert.deepEqual(
    msgs.map((m) => m.body),
    ["b1"],
  );
  await msgs[0].ack();
  assert.deepEqual(sent, [
    [
      "ReceiveMessageCommand",
      { QueueUrl: "https://sqs/q", WaitTimeSeconds: 20, MaxNumberOfMessages: 10 },
    ],
    ["DeleteMessageCommand", { QueueUrl: "https://sqs/q", ReceiptHandle: "h1" }],
  ]);
});

// SW-1245: a pass's later lines (SW-272's "desktop pass owed") reached no log when only lines[0] was logged.
test("every line of a pass reaches the log, the desktop hand-off included", async () => {
  const h = harness([[msg("d1")]], {
    watch: async () => ({ lines: ["#7: no change", "github ingest: desktop pass owed for o/app"] }),
  });
  await h.done();
  assert.ok(h.calls.logs.some((l) => l.includes("(d1): #7: no change")));
  assert.ok(h.calls.logs.some((l) => l.includes("desktop pass owed for o/app")));
});
