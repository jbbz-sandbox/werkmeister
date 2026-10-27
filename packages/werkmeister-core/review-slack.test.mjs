// "Request review" posts to Slack only when both the token and the channel are set.

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.WERKMEISTER_REVIEW_SLACK_TOKEN = "xoxb-test";
delete process.env.WERKMEISTER_REVIEW_SLACK_CHANNEL;
globalThis.fetch = async () => {
  throw new Error("fetch must not be called");
};
const { postSlackReviewRequest } = await import("./dist/sandbox.js");

test("no channel configured → a clear error before any request", async () => {
  await assert.rejects(postSlackReviewRequest("please review"), /WERKMEISTER_REVIEW_SLACK_CHANNEL/);
});
