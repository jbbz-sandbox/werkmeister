// SW-348: a relayed message is a peer-origin user turn (`isMeta: true`,
// `origin.kind: "peer"`) in the session JSONL. The transcript must keep it, and
// relayPickedUp must say whether the target session ran it after the send.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSessionLines } from "./dist/harness/claude/transcript.js";

const session = await import("./dist/harness/claude/session.js");

const RELAY = "Gate decided, continue: re-read stages/02_fix/output/question-approval.md.";
const SENT_AT = "2026-11-02T13:56:26.000Z";

function row(role, content, timestamp, extra = {}) {
  return JSON.stringify({ type: role, message: { role, content }, timestamp, ...extra });
}

/** The row Claude Code writes when another session's message is dequeued and run. */
const peerRow = row(
  "user",
  `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="root" from-mode="prompting">\n${RELAY}\n</cross-session-message>\n\nThis came from another Claude session.`,
  "2026-11-02T14:17:33.589Z",
  { isMeta: true, origin: { kind: "peer", body: RELAY }, turnOrigin: "peer" },
);

test("a peer-origin relay is a user turn in the transcript, with the relayed text (SW-348)", () => {
  const [turn] = parseSessionLines(`${peerRow}\n`);
  assert.equal(turn?.role, "user");
  assert.ok(turn.text.includes(RELAY), turn.text);
});

test("relayPickedUp: no user turn after the send means not picked up, whatever the idle notice says (SW-348)", () => {
  const before = [
    { role: "user", text: "approve", timestamp: "2026-11-02T12:58:00.000Z" },
    {
      role: "assistant",
      text: "Stage 02 (fix) is done and waiting for your approval.",
      timestamp: "2026-11-02T12:58:30.000Z",
    },
  ];
  assert.equal(session.relayPickedUp(before, { sentAt: SENT_AT, text: RELAY }), false);
  // The person typed something else after the send: still not this relay.
  const other = [
    ...before,
    { role: "user", text: "now what?", timestamp: "2026-11-02T14:06:30.000Z" },
  ];
  assert.equal(session.relayPickedUp(other, { sentAt: SENT_AT, text: RELAY }), false);
  const ran = [...before, ...parseSessionLines(`${peerRow}\n`)];
  assert.equal(session.relayPickedUp(ran, { sentAt: SENT_AT, text: RELAY }), true);
});
